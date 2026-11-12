import { createHmac } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { it, expect } from 'vitest';
import { createVoiceServer, type LoadedVoiceSession } from './server.js';

it('AT-FR-CHN-05-2 actual local WebSocket relay correlates signed starts, interrupts playback and rejects a duplicate stream', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const callSid = `CA${'1'.repeat(32)}`,
    accountSid = `AC${'2'.repeat(32)}`;
  const events: { kind: string; key: string; payload: unknown }[] = [];
  const seen = new Set<string>();
  let upstreamConnections = 0;
  let notified = 0;
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const remote = upstream.address();
  if (!remote || typeof remote === 'string') throw new Error('Expected local WebSocket port.');
  const loaded: LoadedVoiceSession = {
    routing: {
      authUserId: id,
      missionId: id,
      credentialRef: id,
      provider: 'twilio',
      sandboxMode: true,
      voiceSessionId: id,
      expiresAt: Date.now() + 60000,
    },
    session: {
      id,
      mission_id: id,
      task_id: id,
      counterparty_id: id,
      mandate_id: null,
      outreach_mandate_id: null,
      twilio_ref: id,
      openai_ref: id,
      language: 'en',
      disclosure: 'I am an AI-assisted agent for the founder.',
      recording_consent: false,
      bounds: {},
    },
    twilio: { accountSid, authToken: 'fixture-auth-token', from: '+15555550000' },
    openai: { apiKey: 'fixture-openai-key', allowedModels: ['test-realtime'] },
    model: 'test-realtime',
    publicOrigin: new URL('https://voice.example'),
    storage: {
      executePreparation: async (_request, invoke) => invoke(),
      scope: { authUserId: id, missionId: id },
      contact: async () => ({
        counterpartyId: id,
        optedOut: false,
        email: 'supplier@example.test',
        phone: '+15555550123',
        phoneVerified: true,
        lastWhatsappInboundAt: null,
        localHoursOpen: true,
        senderRegistered: true,
        disclosure: 'AI-assisted agent.',
        founderBudgetFigures: [],
        approvedTemplates: [],
      }),
      bindVoiceCall: async (_session, sid) => {
        expect(sid).toBe(callSid);
      },
      withVoiceOutput: async (_session, send) => {
        send();
        return true;
      },
      appendVoice: async (_session, kind, key, payload) => {
        if (seen.has(key)) return null;
        seen.add(key);
        events.push({ kind, key, payload });
        return id;
      },
    },
  };
  upstream.on('connection', socket => {
    upstreamConnections++;
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()) as { type: string; session?: { tools: { name: string }[] } };
      if (event.type === 'session.update') {
        expect(event.session?.tools.map(t => t.name)).toEqual(['check_bounds', 'write_fact', 'schedule_followup', 'end_call']);
        for (const frame of [
          { type: 'session.updated' },
          { type: 'response.created', response: { id: 'response1' } },
          { type: 'response.output_item.added', item: { id: 'assistant1', type: 'message' } },
          { type: 'response.output_audio.delta', delta: Buffer.from('safe-fixture-audio').toString('base64') },
          { type: 'response.output_audio_transcript.delta', delta: 'I will confirm in writing.' },
          { type: 'response.done', response: { usage: { total_tokens: 20 } } },
        ])
          socket.send(JSON.stringify(frame));
      }
      if (event.type === 'input_audio_buffer.append') socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    });
  });
  const app = createVoiceServer({
    load: async () => loaded,
    connectRealtime: (url, headers) => {
      expect(url).toBe('wss://api.openai.com/v1/realtime?model=test-realtime');
      expect(headers['Authorization']).toBe('Bearer fixture-openai-key');
      return new WebSocket(`ws://127.0.0.1:${remote.port}`);
    },
    notify: async () => {
      notified++;
    },
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local HTTP port.');
  const local = `http://127.0.0.1:${address.port}`;
  let client: WebSocket | undefined;
  let duplicate: WebSocket | undefined;
  try {
    const form = new URLSearchParams({ AccountSid: accountSid, CallSid: callSid, From: loaded.twilio.from, To: '+15555550123' }).toString();
    const signature = createHmac('sha1', loaded.twilio.authToken)
      .update(
        'https://voice.example/twilio/voice/route' +
          [...new URLSearchParams(form)]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => k + v)
            .join(''),
      )
      .digest('base64');
    const twiml = await fetch(`${local}/twilio/voice/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: form,
    });
    expect(twiml.status).toBe(200);
    expect(await twiml.text()).toContain('<Say');
    const wsSignature = createHmac('sha1', loaded.twilio.authToken).update('https://voice.example/twilio/media/route').digest('base64');
    const frames: Record<string, unknown>[] = [];
    client = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/route`, { headers: { 'X-Twilio-Signature': wsSignature } });
    const connected = client;
    let mediaResolve: () => void = () => {};
    let clearResolve: () => void = () => {};
    const media = new Promise<void>(resolve => {
      mediaResolve = resolve;
    });
    const clear = new Promise<void>(resolve => {
      clearResolve = resolve;
    });
    connected.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame['event'] === 'media') mediaResolve();
      if (frame['event'] === 'clear') clearResolve();
    });
    await new Promise<void>((resolve, reject) => {
      connected.once('open', resolve);
      connected.once('error', reject);
    });
    const start = {
      event: 'start',
      streamSid: 'MZfixture',
      start: {
        streamSid: 'MZfixture',
        callSid,
        accountSid,
        customParameters: { sessionId: id },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    };
    connected.send(JSON.stringify(start));
    await media;
    connected.send(
      JSON.stringify({ event: 'media', streamSid: 'MZfixture', media: { payload: Buffer.from('input-audio').toString('base64') } }),
    );
    await clear;
    expect(frames.map(f => f['event'])).toEqual(['media', 'clear']);
    expect(events.some(e => e.kind === 'transcript')).toBe(false);
    connected.send(JSON.stringify({ event: 'stop', streamSid: 'MZfixture' }));
    await new Promise<void>(resolve => connected.once('close', () => resolve()));
    duplicate = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/route`, { headers: { 'X-Twilio-Signature': wsSignature } });
    const second = duplicate;
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    second.send(JSON.stringify(start));
    await new Promise<void>(resolve => second.once('close', () => resolve()));
    expect(upstreamConnections).toBe(1);
    expect(events.filter(e => e.kind === 'ended')).toHaveLength(1);
    expect(notified).toBeGreaterThanOrEqual(1);
  } finally {
    client?.terminate();
    duplicate?.terminate();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await app.close();
  }
}, 15000);
