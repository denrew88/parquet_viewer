// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { addSvgTitle, canvasClipboardImage, fullScatterRange } from "./chartImageRender";

describe("chart image export", () => {
  it("builds a passive SVG with vector content and an escaped chart title", () => {
    const svg = addSvgTitle(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path class="hover" d="M0 0L4 4"/><style>.hover:hover{fill:red}</style></svg>',
      { title: '한글 & <chart "name">', width: 120, height: 80 },
    );
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    expect(root.localName).toBe("svg");
    expect(root.getAttribute("viewBox")).toBe("0 0 120 112");
    expect(root.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff");
    expect(root.querySelector("text")?.textContent).toBe('한글 & <chart "name">');
    expect(root.querySelector("g")?.getAttribute("transform")).toBe("translate(0 32)");
    expect(root.querySelector("path")?.getAttribute("d")).toBe("M0 0L4 4");
    expect(root.querySelector("style, [class], image")).toBeNull();
  });

  it("keeps full scatter boundaries inside the view, including constant axes", () => {
    expect(fullScatterRange([1, 101, -15, -15])).toEqual([-1, 103, -16, -14]);
    const [xMin, xMax, yMin, yMax] = fullScatterRange([10, 20, -1, 6]);
    expect(xMin).toBeLessThan(10);
    expect(xMax).toBeGreaterThan(20);
    expect(yMin).toBeLessThan(-1);
    expect(yMax).toBeGreaterThan(6);
  });

  it("encodes contiguous RGBA across clipboard base64 chunk boundaries", () => {
    const width = 100;
    const height = 77;
    const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => index % 256);
    const canvas = {
      width,
      height,
      getContext: () => ({ getImageData: () => ({ data }) }),
    } as unknown as HTMLCanvasElement;
    const result = canvasClipboardImage(canvas);
    expect(result).toMatchObject({ width, height });
    expect(
      Uint8ClampedArray.from(atob(result.rgba), (character) => character.charCodeAt(0)),
    ).toEqual(data);
  });
});
