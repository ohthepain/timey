import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAuth } from '~/server/auth';

const handle = async ({ request }: { request: Request }) => (await getAuth()).handler(request);

// Return the original Response: Set-Cookie must survive the framework boundary.
export const APIRoute = createAPIFileRoute('/api/auth/$')({ GET: handle, POST: handle });
