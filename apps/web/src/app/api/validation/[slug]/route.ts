import { readValidationPage, recordWaitlistSignup } from '@lo/runtime';
import { readJsonBody } from '../../../../lib/request-body';
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const page = await readValidationPage((await params).slug);
    return page ? Response.json({ page }, { headers: { 'Cache-Control': 'no-store' } }) : new Response('Not found', { status: 404 });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) return new Response('Origin denied', { status: 403 });
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return new Response('Request too large', { status: 413 });
  try {
    const input = (await readJsonBody(request, 4096)) as Record<string, unknown>;
    await recordWaitlistSignup({ ...input, slug: (await params).slug });
    return Response.json({ ok: true, message: 'Your signup was recorded.' });
  } catch (error) {
    return Response.json(
      { ok: false, error: 'Signup could not be recorded. Check the email and consent, then retry.' },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
}
