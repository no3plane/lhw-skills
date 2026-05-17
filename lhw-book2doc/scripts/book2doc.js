#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function usage() {
  console.error("Usage: book2doc.js INPUT [OUTPUT] [md|txt]");
}

function commandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });

  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `${command} failed`;
    throw new Error(message.trim());
  }

  return result;
}

function normalizeFormat(value) {
  const format = (value || "md").toLowerCase();
  if (format === "md" || format === "markdown") return "md";
  if (format === "txt" || format === "plain" || format === "text") return "txt";
  throw new Error(`Unsupported output format: ${value}. Use md or txt.`);
}

function cleanupText(filePath) {
  let text = fs.readFileSync(filePath, "utf8");

  const normalizeImage = (_match, altText) => {
    const alt = altText.trim();
    if (!alt || alt.toLowerCase() === "alt") return "";
    return `图像说明：${alt}\n`;
  };

  text = text
    .replace(/<sup>\s*<a\b[^>]*>(.*?)<\/a>\s*<\/sup>/gs, "$1")
    .replace(/<a\b[^>]*>(.*?)<\/a>/gs, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:div|p|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>\n]+>/g, "")
    .replace(/\[([^\]]+)\]\(#part[0-9]+\.xhtml[^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)\n?/g, normalizeImage)
    .replace(/^\[(?:alt)?\]\s*\n/gm, "")
    .replace(/\bpart\d+\.xhtml\b/g, "")
    .replace(/\bImages\/[^\s)]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");

  fs.writeFileSync(filePath, text, "utf8");
}

function wrapPlainAsMarkdown(source, target, title) {
  const body = fs.readFileSync(source, "utf8");
  fs.writeFileSync(target, `# ${title}\n\n${body}`, "utf8");
}

function convertWithPandoc(input, output, format) {
  if (!commandExists("pandoc")) {
    throw new Error("Missing required command: pandoc");
  }

  const writer = format === "md" ? "gfm" : "plain";
  run("pandoc", [input, "-t", writer, "--wrap=none", "-o", output]);
}

function extractPdfText(pdfPath, target) {
  if (commandExists("pdftotext")) {
    run("pdftotext", ["-layout", pdfPath, target]);
    return;
  }

  if (commandExists("pandoc")) {
    run("pandoc", [pdfPath, "-t", "plain", "--wrap=none", "-o", target]);
    return;
  }

  throw new Error("PDF extraction needs pdftotext or pandoc.");
}

function ocrPdfToText(pdfPath, target, tmpDir) {
  const ocrPdf = path.join(tmpDir, "ocr.pdf");

  if (commandExists("ocrmypdf")) {
    run("ocrmypdf", [
      "--skip-text",
      "--deskew",
      "--language",
      "chi_sim+chi_tra+eng",
      pdfPath,
      ocrPdf,
    ]);
    extractPdfText(ocrPdf, target);
    return;
  }

  if (commandExists("tesseract") && commandExists("pdftoppm")) {
    const pageDir = path.join(tmpDir, "pages");
    fs.mkdirSync(pageDir, { recursive: true });
    const pagePrefix = path.join(pageDir, "page");

    run("pdftoppm", ["-r", "220", "-png", pdfPath, pagePrefix]);

    const images = fs
      .readdirSync(pageDir)
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => path.join(pageDir, name));

    fs.writeFileSync(target, "", "utf8");
    for (const image of images) {
      const result = run("tesseract", [image, "stdout", "-l", "chi_sim+chi_tra+eng"]);
      fs.appendFileSync(target, `${result.stdout}\n\n`, "utf8");
    }
    return;
  }

  throw new Error(
    "This PDF appears to need OCR, but no OCR tool was found. Install ocrmypdf or tesseract with language data."
  );
}

function convertMobiLike(input, output, format, tmpDir) {
  if (!commandExists("ebook-convert")) {
    const ext = path.extname(input).slice(1).toLowerCase();
    throw new Error(`Converting ${ext} requires Calibre ebook-convert, which is not installed.`);
  }

  const intermediate = path.join(tmpDir, "book.epub");
  run("ebook-convert", [input, intermediate]);
  convertWithPandoc(intermediate, output, format);
}

function warnForResidue(output) {
  const text = fs.readFileSync(output, "utf8");
  const pattern = /(^\[(alt)?\]$|!\[[^\]]*\]\(|<[^>]+>|part[0-9]+\.xhtml|Images\/)/gm;
  const warnings = [];
  let match;

  while ((match = pattern.exec(text)) && warnings.length < 20) {
    const line = text.slice(0, match.index).split("\n").length;
    const lineText = text.split("\n")[line - 1];
    warnings.push(`${line}:${lineText}`);
  }

  if (warnings.length > 0) {
    console.error("Warning: possible conversion residue remains:");
    console.error(warnings.join("\n"));
  }
}

function main() {
  const [, , inputArg, outputArg, formatArg] = process.argv;

  if (!inputArg || process.argv.length > 5) {
    usage();
    process.exit(2);
  }

  const input = path.resolve(inputArg);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
    throw new Error(`Input file not found: ${inputArg}`);
  }

  const format = normalizeFormat(formatArg);
  const parsed = path.parse(input);
  const output = path.resolve(outputArg || path.join(parsed.dir, `${parsed.name}.ai.${format}`));
  const ext = parsed.ext.slice(1).toLowerCase();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "book2doc-"));

  try {
    if (["epub", "html", "htm", "docx", "rtf", "odt", "md", "markdown"].includes(ext)) {
      convertWithPandoc(input, output, format);
    } else if (ext === "txt") {
      if (format === "md") {
        wrapPlainAsMarkdown(input, output, parsed.name);
      } else {
        fs.copyFileSync(input, output);
      }
    } else if (ext === "pdf") {
      const raw = path.join(tmpDir, "pdf.txt");
      extractPdfText(input, raw);

      const charCount = fs.readFileSync(raw, "utf8").replace(/\s/g, "").length;
      if (charCount < 800) {
        console.error(`PDF text extraction was sparse (${charCount} chars); attempting OCR...`);
        ocrPdfToText(input, raw, tmpDir);
      }

      if (format === "md") {
        wrapPlainAsMarkdown(raw, output, parsed.name);
      } else {
        fs.copyFileSync(raw, output);
      }
    } else if (["mobi", "azw3", "fb2"].includes(ext)) {
      convertMobiLike(input, output, format, tmpDir);
    } else {
      throw new Error(`Unsupported extension: ${ext}`);
    }

    cleanupText(output);

    const size = fs.statSync(output).size;
    console.log(`Created: ${output}`);
    console.log(`Size: ${size} bytes`);
    warnForResidue(output);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
