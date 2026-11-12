import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  origin: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('./auth', () => ({ currentActor: mocks.actor, sameOrigin: mocks.origin }));
vi.mock('@lo/runtime/local-paypal', () => ({
  localPayPalStatus: mocks.status,
  createLocalPayPalOrder: mocks.create,
  captureLocalPayPalOrder: mocks.capture,
}));
import { GET, POST } from '../app/api/local/paypal/route';
const actorId = '00000000-0000-4000-8000-000000000001';
const requestId = '11111111-1111-4111-8111-111111111111';
function post(body: unknown) {
  return new Request('http://127.0.0.1:3100/api/local/paypal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('LO_STORAGE_BACKEND', 'sqlite');
  vi.stubEnv('LO_EXECUTION_MODE', 'local');
  mocks.actor.mockResolvedValue({ authUserId: actorId, local: true });
  mocks.origin.mockReturnValue(true);
  mocks.status.mockReturnValue({ configured: false });
});
afterEach(() => vi.unstubAllEnvs());
describe('local PayPal HTTP boundary', () => {
  it('requires the signed-in local founder even for availability', async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(post({ action: 'create', requestId }))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('blocks cross-origin requests and disappears from the full backend', async () => {
    mocks.origin.mockReturnValue(false);
    expect((await POST(post({ action: 'create', requestId }))).status).toBe(403);
    vi.stubEnv('LO_STORAGE_BACKEND', 'postgres');
    expect((await GET()).status).toBe(404);
    expect((await POST(post({ action: 'create', requestId }))).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('never accepts a caller-selected amount, merchant, callback URL or live mode', async () => {
    for (const extra of [{ amount: 100 }, { merchant: 'other' }, { returnUrl: 'https://elsewhere.example' }, { sandbox: false }])
      expect((await POST(post({ action: 'create', requestId, ...extra }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('forwards only the authenticated owner and durable request identity', async () => {
    mocks.create.mockResolvedValue({
      orderId: 'ORDER12345',
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345',
      status: 'CREATED',
    });
    const response = await POST(post({ action: 'create', requestId }));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(actorId, requestId);
    expect(await response.json()).toMatchObject({ ok: true, sandbox: true, status: 'CREATED' });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('GET cannot capture; capture requires a separate explicit POST', async () => {
    await GET();
    expect(mocks.capture).not.toHaveBeenCalled();
    mocks.capture.mockResolvedValue({
      orderId: 'ORDER12345',
      captureId: 'CAPTURE123',
      status: 'COMPLETED',
      amount: '1.00',
      currency: 'USD',
    });
    const response = await POST(post({ action: 'capture', orderId: 'ORDER12345' }));
    expect(response.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledWith(actorId, 'ORDER12345');
  });
  it('redacts provider errors and never turns an ambiguous capture into a success', async () => {
    mocks.capture.mockRejectedValue(new Error('SECRET_PROVIDER_TOKEN'));
    const response = await POST(post({ action: 'capture', orderId: 'ORDER12345' }));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('SECRET_PROVIDER_TOKEN');
    expect(body).toContain('No successful payment is claimed');
  });
});
