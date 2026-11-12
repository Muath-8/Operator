import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment } from './config.js';
import { generateLocalReply, localCodexArguments } from './local-ai.js';
afterEach(() => vi.unstubAllEnvs());
describe('local testing mode boundaries', () => {
  it('rejects SQLite and subscription AI in deployed modes', () => {
    expect(() => environment({ NODE_ENV: 'production', LO_STORAGE_BACKEND: 'sqlite' })).toThrow();
    expect(() => environment({ LO_EXECUTION_MODE: 'sandbox', LO_STORAGE_BACKEND: 'sqlite' })).toThrow();
    expect(() => environment({ LO_LOCAL_AI: 'codex' })).toThrow();
    expect(environment({}).LO_STORAGE_BACKEND).toBe('postgres');
  });
  it('returns an explicitly simulated response without any network call', async () => {
    vi.stubEnv('LO_STORAGE_BACKEND', 'sqlite');
    vi.stubEnv('LO_EXECUTION_MODE', 'local');
    vi.stubEnv('LO_LOCAL_AI', 'simulated');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const reply = await generateLocalReply({ message: 'Test my launch plan', missionTitle: 'Test mission' });
    expect(reply.source).toBe('simulated');
    expect(reply.text).toContain('no payment was sent');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it('keeps the subscription CLI read-only and disables execution, plugins and browsing', () => {
    const args = localCodexArguments('C:/temporary/example');
    expect(args).toContain('read-only');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('shell_tool');
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
