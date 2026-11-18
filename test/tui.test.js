import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createScreen, multiSelectList, selectList } from '../src/ui/tui.js';

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;

  const frames = [];
  output.on('data', (chunk) => frames.push(chunk.toString()));

  return { input, output, frames };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const KEYS = {
  down: '\u001b[B',
  up: '\u001b[A',
  enter: '\r',
  space: ' ',
};

const items = [
  { label: 'alpha', value: 'a' },
  { label: 'beta', value: 'b' },
  { label: 'gamma', value: 'c' },
];

test('select: arrows move and enter picks the focused item', async () => {
  const { input, output } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = selectList({ screen, items, title: 'pick one' });
  await tick();
  input.write(KEYS.down);
  await tick();
  input.write(KEYS.enter);

  assert.equal(await pending, 'b');
});

test('select: q cancels without a value', async () => {
  const { input, output } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = selectList({ screen, items });
  await tick();
  input.write('q');

  assert.equal(await pending, null);
});

test('select: wraps around at the edges', async () => {
  const { input, output } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = selectList({ screen, items });
  await tick();
  input.write(KEYS.up);
  await tick();
  input.write(KEYS.enter);

  assert.equal(await pending, 'c');
});

test('multiSelect: space toggles, a selects all, enter confirms', async () => {
  const { input, output } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = multiSelectList({ screen, items });
  await tick();
  input.write(KEYS.space);
  await tick();
  input.write('a');
  await tick();
  input.write(KEYS.enter);

  assert.deepEqual(await pending, ['a', 'b', 'c']);
});

test('multiSelect: preselection is honoured and n clears it', async () => {
  const { input, output } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = multiSelectList({ screen, items, preselected: [0, 2] });
  await tick();
  input.write('n');
  await tick();
  input.write(KEYS.down);
  await tick();
  input.write(KEYS.space);
  await tick();
  input.write(KEYS.enter);

  assert.deepEqual(await pending, ['b']);
});

test('multiselect renders checkboxes and the selection counter', async () => {
  const { input, output, frames } = fakeTerminal();
  const screen = createScreen({ input, output });

  const pending = multiSelectList({ screen, items, preselected: [1] });
  await tick();
  input.write('q');
  await pending;

  const rendered = frames.join('');
  assert.match(rendered, /1 of 3 selected/);
  assert.match(rendered, /beta/);
});

test('the screen leaves the alternate buffer on request', () => {
  const { input, output, frames } = fakeTerminal();
  const screen = createScreen({ input, output });

  screen.enter();
  screen.render(['hello']);
  screen.leave();

  const rendered = frames.join('');
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /hello/);
  assert.match(rendered, /\u001b\[\?1049l/);
});
