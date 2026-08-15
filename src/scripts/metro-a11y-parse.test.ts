import { describe, it, expect } from "vitest";
import { parseCsvLine } from "../utils/csv";
import { rowToMetroA11yDoc } from "./metro-a11y-parse";

describe("rowToMetroA11yDoc", () => {
	it("maps a valid row into an Accessibility doc with GeoJSON location", () => {
		const doc = rowToMetroA11yDoc(
			parseCsvLine("1,動物園站出口電梯1,出口1,121.5797157,24.9982136"),
		);
		expect(doc).toEqual({
			項次: "1",
			"出入口電梯/無障礙坡道名稱": "動物園站出口電梯1",
			經度: 121.5797157,
			緯度: 24.9982136,
			location: {
				type: "Point",
				coordinates: [121.5797157, 24.9982136],
			},
		});
	});

	it("keeps quoted names containing commas intact", () => {
		const doc = rowToMetroA11yDoc(
			parseCsvLine('3,"某站出口電梯,特別款",單一出口,121.5,25.0'),
		);
		expect(doc?.["出入口電梯/無障礙坡道名稱"]).toBe("某站出口電梯,特別款");
		expect(doc?.location.coordinates).toEqual([121.5, 25.0]);
	});

	it("returns null for a row with an empty name", () => {
		expect(rowToMetroA11yDoc(parseCsvLine("5,,出口1,121.5,25.0"))).toBeNull();
	});

	it("returns null for non-finite coordinates", () => {
		expect(
			rowToMetroA11yDoc(parseCsvLine("6,某站出口電梯,出口1,abc,25.0")),
		).toBeNull();
		expect(
			rowToMetroA11yDoc(parseCsvLine("7,某站出口電梯,出口1,121.5,")),
		).toBeNull();
	});

	it("returns null for coordinates outside Taiwan", () => {
		expect(
			rowToMetroA11yDoc(parseCsvLine("8,某站出口電梯,出口1,100.0,25.0")),
		).toBeNull();
		expect(
			rowToMetroA11yDoc(parseCsvLine("9,某站出口電梯,出口1,121.5,40.0")),
		).toBeNull();
	});
});
