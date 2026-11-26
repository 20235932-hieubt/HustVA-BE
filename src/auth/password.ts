import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const hashPattern = /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/u;
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  if (!hashPattern.test(hash)) return false;
  const [, salt, expected] = hash.split('$');
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
