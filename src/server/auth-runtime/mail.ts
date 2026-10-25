import nodemailer from 'nodemailer';
import { z } from 'zod';

/** Server-owned SMTP transport, compatible with capture servers and authenticated SMTP. */
export function passwordResetDelivery() {
  const config = z
    .object({
      SMTP_HOST: z.string().min(1),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535),
      SMTP_FROM: z.email(),
      SMTP_SECURE: z.enum(['true', 'false']),
      SMTP_USER: z.string().min(1).optional(),
      SMTP_PASSWORD: z.string().min(1).optional(),
    })
    .parse(process.env);
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD))
    throw new Error('SMTP credentials must be configured together');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(config.SMTP_HOST);
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === 'true',
    requireTLS: !loopback,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD! } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return async ({ user, url }: { user: { email: string }; url: string }) => {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to: user.email,
      subject: 'Reset your Timey password',
      text: `Choose a new password for your Timey account:\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
    });
  };
}
