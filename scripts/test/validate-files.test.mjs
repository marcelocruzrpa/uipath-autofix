// File checks that run before a patch is published.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bash, noBash, tempDir } from "./helpers.mjs";

// The XML check needs a working python3 (present on GitHub's runners).
const python = noBash ? null : spawnSync("bash", ["-c", "python3 -c 'print(1)'"], { encoding: "utf8" });
const skip = noBash || (python?.status === 0 ? false : "python3 is not available");

/** Write the files into a temp project dir and validate all of them. */
function validate(files) {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, "list.z"), Object.keys(files).map((n) => `${n}\0`).join(""));
  return bash("validate-files.sh", ["list.z"], { cwd: dir });
}

const XAML = '<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence /></Activity>';

describe("validate-files.sh", { skip }, () => {
  it("accepts well-formed XAML and valid JSON, with or without a BOM", () => {
    const r = validate({ "Main.xaml": XAML, "Validação.xaml": XAML, "project.json": '{"name":"x"}', "bom.json": '﻿{"name":"x"}' });
    assert.equal(r.code, 0, r.out);
  });

  it("rejects XML that is not well-formed", () => {
    const r = validate({ "Main.xaml": "<Activity><Sequence></Activity>" });
    assert.equal(r.code, 1);
    assert.match(r.out, /mismatched tag/);
    assert.match(r.out, /not well-formed XML: Main\.xaml/);
  });

  it("rejects an element whose namespace prefix is not declared", () => {
    const r = validate({ "Main.xaml": "<Activity><ui:Click /></Activity>" });
    assert.equal(r.code, 1);
    assert.match(r.out, /unbound prefix/);
  });

  it("rejects a DTD or entity declaration", () => {
    const r = validate({ "Main.xaml": `<!DOCTYPE a [<!ENTITY x "y">]>${XAML}` });
    assert.equal(r.code, 1);
    assert.match(r.out, /DTD\/entity declarations are not allowed/);
  });

  it("rejects a DTD in a UTF-16 file, which an ASCII grep cannot see", () => {
    const doc = `﻿<?xml version="1.0" encoding="utf-16"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`;
    const r = validate({ "Main.xaml": Buffer.from(doc, "utf16le") });
    assert.equal(r.code, 1);
    assert.match(r.out, /DTD\/entity declarations are not allowed/);
  });

  it("rejects invalid JSON", () => {
    const r = validate({ "project.json": "{ not json" });
    assert.equal(r.code, 1);
    assert.match(r.out, /invalid JSON: project\.json/);
  });

  it("checks by extension case-insensitively and ignores deleted files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Main.XAML"), "<a><b></a>");
    writeFileSync(join(dir, "list.z"), "Main.XAML\0Deleted.xaml\0");
    const r = bash("validate-files.sh", ["list.z"], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /not well-formed XML: Main\.XAML/);
    assert.doesNotMatch(r.out, /Deleted/);
  });
});
