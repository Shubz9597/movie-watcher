import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native sizing preserves Fit, crops Fill, and stretches inside a protected 16:9 viewport without resizing the drawable', () => {
  const support = fileURLToPath(new URL('../ios/App/VLCDependency/Sources/', import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), 'torwatch-video-layout-'));
  const driver = path.join(directory, 'layout.c');
  const binary = path.join(directory, 'layout');
  writeFileSync(driver, `
#include "VLCSupport.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc != 5) return 1;
    TorWatchVideoLayout layout = torwatch_video_layout(atof(argv[1]), atof(argv[2]), atof(argv[3]), atoi(argv[4]));
    printf("[%0.12f,%0.12f,%0.12f,%0.12f,%0.12f]", layout.width, layout.height, layout.scale_x, layout.scale_y, layout.viewport_width);
}
`);
  try {
    execFileSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', path.join(support, 'include'), path.join(support, 'VLCSupport.c'), driver, '-lm', '-o', binary]);
    const layout = (width, height, aspect, mode) => JSON.parse(execFileSync(binary, [width, height, aspect, mode].map(String), {encoding:'utf8'}));
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`);
    for (const [width, height, aspect] of [
      [874, 402, 4 / 3], // recorded iPhone: narrow anime on a wide screen
      [844, 390, 2.39], // cinema video: crop sides to fill this screen
      [390, 844, 16 / 9], // denied landscape rotation
      [1024, 768, 16 / 9], // iPad
      [512, 768, 4 / 3], // iPad split view
      [844, 390, (720 / 576) * (16 / 15)], // anamorphic pixels
      [800, 600, 4 / 3], // identical source and viewport aspect
      [1280, 588, 4 / 3], // user's YouTube reference has ~117px side bars
      [874 - 2 * 59, 402, 4 / 3], // iPhone viewport after symmetric notch insets
    ]) {
      const fit = layout(width, height, aspect, 0);
      const fill = layout(width, height, aspect, 1);
      const stretch = layout(width, height, aspect, 2);
      close(fit[0] / fit[1], aspect);
      assert.ok(fit[0] <= width + 0.000001 && fit[1] <= height + 0.000001, 'Fit keeps every edge visible');
      assert.deepEqual(fit.slice(2, 4), [1, 1]);
      close(fit[4], width);
      assert.deepEqual(fill.slice(0, 2), fit.slice(0, 2));
      assert.deepEqual(stretch.slice(0, 2), fit.slice(0, 2));
      close(fill[2], fill[3]);
      assert.ok(fill[0] * fill[2] >= width - 0.000001 && fill[1] * fill[3] >= height - 0.000001, 'Fill covers every screen edge without distortion');
      close(fill[4], width);
      close(stretch[4], Math.min(width, height * 16 / 9));
      close(stretch[0] * stretch[2], stretch[4]);
      close(stretch[1] * stretch[3], height);
      assert.deepEqual(layout(width, height, aspect, 0), fit, 'returning to Fit removes all transforms');
    }
    for (const dimensions of [[0, 390, 4 / 3], [844, 0, 4 / 3], [844, 390, 0], [844, 390, -1], ['nan', 390, 4 / 3], [844, 390, 'inf']]) {
      assert.deepEqual(layout(...dimensions, 2), [0, 0, 1, 1, 0]);
    }
    const reference = layout(1280, 588, 4 / 3, 2);
    close((1280 - reference[4]) / 2, 117.333333333333);
    const notchedPhone = layout(874 - 2 * 59, 402, 4 / 3, 2);
    assert.ok((874 - notchedPhone[4]) / 2 >= 59, 'Stretch leaves at least the notch safe inset on both sides');
  } finally {
    rmSync(directory, {recursive:true, force:true});
  }
});
