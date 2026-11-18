import { createInterface } from 'node:readline/promises';

export async function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function askYesNo(question, options = {}) {
  const answer = (await ask(`${question} [y/N] `, options)).trim().toLowerCase();
  return ['y', 'yes', 's', 'si', 'sí'].includes(answer);
}

export async function askText(question, options = {}) {
  return (await ask(`${question} `, options)).trim();
}
