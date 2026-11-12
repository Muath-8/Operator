import { serve } from 'inngest/next';
import { inngest, runtimeFunctions } from '@lo/runtime/inngest';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const { GET, POST, PUT } = serve({ client: inngest, functions: runtimeFunctions });
