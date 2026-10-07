import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function createPasswordRecord(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 120 || /\s/.test(password)) throw new Error('Use a unique 16-120 character password without whitespace');
  const salt = randomBytes(16).toString('hex');
  return { algorithm: 'scrypt-v1', salt, digest: scryptSync(password, salt, 32).toString('hex') };
}

export function verifyPassword(password, record) {
  if (record?.algorithm !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(record.salt || '') || !/^[a-f0-9]{64}$/.test(record.digest || '')) throw new Error('Invalid password configuration');
  if (typeof password !== 'string' || password.length < 16 || password.length > 120) return false;
  return timingSafeEqual(scryptSync(password, record.salt, 32), Buffer.from(record.digest, 'hex'));
}
