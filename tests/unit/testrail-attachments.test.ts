import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { guessAttachmentMime } from '../../src/server/services/testrail';

test('guessAttachmentMime maps video extensions for inline playback', () => {
  assert.equal(guessAttachmentMime('720p - Screen Recording.mov'), 'video/quicktime');
  assert.equal(guessAttachmentMime('clip.MP4'), 'video/mp4');
  assert.equal(guessAttachmentMime('capture.webm'), 'video/webm');
});

test('guessAttachmentMime maps common image extensions', () => {
  assert.equal(guessAttachmentMime('shot.png'), 'image/png');
  assert.equal(guessAttachmentMime('photo.JPG'), 'image/jpeg');
  assert.equal(guessAttachmentMime('art.webp'), 'image/webp');
});

test('guessAttachmentMime returns empty for unknown or missing extensions', () => {
  assert.equal(guessAttachmentMime('archive.xyz'), '');
  assert.equal(guessAttachmentMime('noextension'), '');
  assert.equal(guessAttachmentMime(''), '');
});
