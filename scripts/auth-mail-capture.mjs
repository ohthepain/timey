import { SMTPServer } from 'smtp-server';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [port, directory] = process.argv.slice(2);
let sequence = 0;
// Fixture only: bind loopback, accept mail without forwarding it anywhere.
const server = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  onData(stream, _session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', callback);
    stream.on('end', () => {
      writeFile(join(directory, `mail-${++sequence}.eml`), Buffer.concat(chunks)).then(() => callback(), callback);
    });
  },
});
server.listen(Number(port), '127.0.0.1', () => console.log('SMTP capture ready'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
