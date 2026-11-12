import { handleProviderWebhook } from '@lo/runtime/webhooks';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ provider: string; route: string }> }): Promise<Response> {
  const input = await params;
  return handleProviderWebhook(input.provider, input.route, request);
}
