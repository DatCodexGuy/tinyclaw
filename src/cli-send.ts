#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { QUEUE_INCOMING, QUEUE_OUTGOING } from './lib/config';
import { MessageData, ResponseData } from './lib/types';

const DEFAULT_WAIT_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 500;

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function findOutgoingResponse(messageId: string): { file: string; data: ResponseData } | null {
    const files = fs.readdirSync(QUEUE_OUTGOING).filter((f) => f.endsWith('.json'));
    for (const file of files) {
        const full = path.join(QUEUE_OUTGOING, file);
        try {
            const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as ResponseData;
            if (parsed.messageId === messageId) {
                return { file: full, data: parsed };
            }
        } catch {
            // Ignore malformed files
        }
    }
    return null;
}

async function main(): Promise<void> {
    const message = process.argv[2];
    const source = process.argv[3] || 'cli';

    if (!message || !message.trim()) {
        console.error('Usage: tinyclaw send "<message>"');
        process.exit(1);
    }

    ensureDir(QUEUE_INCOMING);
    ensureDir(QUEUE_OUTGOING);

    const messageId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload: MessageData = {
        channel: 'cli',
        sender: 'cli',
        senderId: source,
        message: message.trim(),
        timestamp: Date.now(),
        messageId,
    };

    const incomingFile = path.join(QUEUE_INCOMING, `${messageId}.json`);
    fs.writeFileSync(incomingFile, JSON.stringify(payload, null, 2));

    const timeoutMs = Number(process.env.TINYCLAW_CLI_SEND_TIMEOUT_MS || DEFAULT_WAIT_TIMEOUT_MS);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const found = findOutgoingResponse(messageId);
        if (found) {
            const { file, data } = found;
            try {
                fs.unlinkSync(file);
            } catch {
                // Best effort cleanup
            }
            process.stdout.write((data.message || '').trim() + '\n');
            if (data.files && data.files.length > 0) {
                process.stdout.write(`\n[files]\n${data.files.join('\n')}\n`);
            }
            return;
        }
        await sleep(POLL_INTERVAL_MS);
    }

    console.error(`error: timed out waiting for queue response after ${timeoutMs}ms`);
    console.error('hint: ensure queue processor is running: tinyclaw start');
    process.exit(2);
}

main().catch((error) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
});

