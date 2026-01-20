# Markdown to HTML with Pandoc

Notes on converting markdown files to attractive, standalone HTML pages.

## Quick Option: grip

If this is a one-off, try [grip](https://github.com/joeyespo/grip). `grip --export README.md` produces beautiful output. However, since it uses the GitHub API to perfectly replicate GitHub's rendering, you have to worry about rate-limiting.

## Better Option: pandoc

[Pandoc](https://pandoc.org/index.html) is more flexible but requires some setup to produce attractive output.

### The Problem

Out of the box, pandoc's HTML output is unstyled and doesn't look great. Getting it to produce HTML that:
- Looks attractive (GitHub-style)
- Preserves favicons
- Is mobile-friendly

...takes some work.

### The Solution

[Sindre Sorhus](https://github.com/sindresorhus) did most of the heavy lifting with the [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) project.

What remains is getting pandoc to use that CSS.

### Step-by-Step Setup

1. **Install pandoc:**
   ```bash
   brew install pandoc
   ```

2. **Export the default template:**
   ```bash
   pandoc -D html5 > template.html
   ```

3. **Download the GitHub CSS:**
   ```bash
   wget https://raw.githubusercontent.com/sindresorhus/github-markdown-css/gh-pages/github-markdown.css
   ```

4. **Modify the template:**

   Follow the [Usage](https://github.com/sindresorhus/github-markdown-css?tab=readme-ov-file#usage) instructions from the repo:
   - Add the suggested CSS
   - Add `class="markdown-body"` to the element surrounding pandoc's `$body$`

5. **Handle the title warning:**

   Pandoc warns: `[WARNING] This document format requires a nonempty <title> element.`

   Since markdown files typically use `#` for titles, the `<title>` element feels redundant. Silence the warning by supplying a space as the title (`title=" "`).

### Final Command

```bash
pandoc -f gfm -t html5 -o README.html README.md \
    --css github-markdown.css \
    --embed-resources \
    --standalone \
    --metadata title=" " \
    --template template.html
```

### Flags Explained

- `-f gfm` - Input format: GitHub-Flavored Markdown
- `-t html5` - Output format: HTML5
- `--css` - Include this stylesheet
- `--embed-resources` - Embed all resources (images, CSS) in the output file
- `--standalone` - Produce a complete HTML document (not a fragment)
- `--metadata title=" "` - Silence the title warning with a space
- `--template` - Use our customized template

### Result

A single, self-contained HTML file with no external dependencies that looks like GitHub's markdown rendering.
