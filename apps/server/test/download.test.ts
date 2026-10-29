import assert from "node:assert/strict";
import test from "node:test";
import { pickPlayUrls } from "../src/download.ts";

test("抖音视频优先选不超过 720p 的最高码率 H.264", () => {
  const urls = pickPlayUrls({
    play_addr: { url_list: ["default"] },
    bit_rate: [
      { bit_rate: 2_000_000, is_h265: 0, play_addr: { url_list: ["h264-1080"], width: 1440, height: 1080 } },
      { bit_rate: 900_000, is_h265: 1, play_addr: { url_list: ["h265-720"], width: 1280, height: 720 } },
      { bit_rate: 600_000, is_h265: 0, play_addr: { url_list: ["h264-540"], width: 1024, height: 576 } },
      { bit_rate: 800_000, is_h265: 0, play_addr: { url_list: ["h264-720-portrait"], width: 720, height: 1280 } },
    ],
  });
  assert.deepEqual(urls, ["h264-720-portrait"]);
});

test("没有合适清晰度时退回最高码率 H.264，再退回默认地址", () => {
  assert.deepEqual(pickPlayUrls({ bit_rate: [{ bit_rate: 1, is_h265: 0, play_addr: { url_list: ["only-1080"], width: 1920, height: 1080 } }] }), ["only-1080"]);
  assert.deepEqual(pickPlayUrls({ play_addr: { url_list: ["default"] }, bit_rate: [] }), ["default"]);
});
