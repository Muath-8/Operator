import { describe, it, expect } from 'vitest';
import { readJsonBody } from './request-body';
describe('bounded streamed ingress', () => {
  it('bounds bytes regardless of absent or misleading Content-Length', async () => {
    await expect(
      readJsonBody(new Request('https://example.test', { method: 'POST', body: '{"x":"' + 'a'.repeat(4096) + '"}' }), 4096),
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonBody(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'content-length': '1' },
          body: '{"x":"' + 'a'.repeat(4096) + '"}',
        }),
        4096,
      ),
    ).rejects.toThrow(RangeError);
    await expect(readJsonBody(new Request('https://example.test', { method: 'POST', body: '{"x":1}' }), 4096)).resolves.toEqual({ x: 1 });
  });
});
