import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig } from './types';
import { SCRIPT_DIR, resolveClaudeModel, resolveCodexModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

const DEFAULT_COMMAND_TIMEOUT_MS = 180000;

function resolveCommandTimeoutMs(): number {
    const raw = process.env.TINYCLAW_AGENT_TIMEOUT_MS;
    if (!raw) return DEFAULT_COMMAND_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
    return Math.floor(parsed);
}

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
    const timeoutMs = resolveCommandTimeoutMs();

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            const summary = `${command} ${args.join(' ')}`;
            log('WARN', `Command timed out after ${timeoutMs}ms: ${summary}`);
            child.kill('SIGTERM');
            setTimeout(() => {
                if (!settled) child.kill('SIGKILL');
            }, 5000);
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (code === 0) {
                resolve(stdout);
                return;
            }

            if (signal) {
                reject(new Error(`Command terminated by signal ${signal} after ${timeoutMs}ms`));
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {}
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // Resolve working directory
    const workingDir = agent.working_directory
        ? (path.isAbsolute(agent.working_directory)
            ? agent.working_directory
            : path.join(workspacePath, agent.working_directory))
        : agentDir;

    const provider = agent.provider || 'anthropic';

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const modelId = resolveCodexModel(agent.model);
        const codexArgs = ['exec'];
        if (shouldResume) {
            codexArgs.push('resume', '--last');
        }
        if (modelId) {
            codexArgs.push('--model', modelId);
        }
        codexArgs.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);

        const codexOutput = await runCommand('codex', codexArgs, workingDir);

        // Parse JSONL output and extract assistant text across known event shapes.
        let response = '';
        const lines = codexOutput.trim().split('\n');
        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message' && typeof json.item?.text === 'string') {
                    response = json.item.text;
                    continue;
                }

                // Fallbacks for schema variants (message/content/output_text).
                const candidate = extractTextCandidate(json);
                if (candidate) {
                    response = candidate;
                }
            } catch (_e) {
                // Ignore lines that aren't valid JSON
            }
        }

        // Final fallback: if Codex returned non-empty output but no recognized JSON shape,
        // return the plain output instead of a misleading empty-response message.
        const trimmed = codexOutput.trim();
        return response || trimmed || 'Sorry, I could not generate a response from Codex.';
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting conversation for agent: ${agentId}`);
        }

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        claudeArgs.push('-p', message);

        return await runCommand('claude', claudeArgs, workingDir);
    }
}

function extractTextCandidate(event: any): string | null {
    const values: Array<unknown> = [
        event?.output_text,
        event?.text,
        event?.message?.text,
        event?.item?.text,
    ];

    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }

    const contentLists: Array<unknown> = [
        event?.item?.content,
        event?.message?.content,
        event?.content,
    ];

    for (const list of contentLists) {
        if (!Array.isArray(list)) continue;
        const parts: string[] = [];
        for (const chunk of list) {
            const text = (chunk as any)?.text;
            if (typeof text === 'string' && text.trim()) {
                parts.push(text.trim());
            }
        }
        if (parts.length > 0) return parts.join('\n').trim();
    }

    return null;
}
