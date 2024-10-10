# So you want to convert Github-Flavored Markdown (GFM) to HTML

If this is a one-off, try [grip](https://github.com/joeyespo/grip). `grip --export README.md` produces beautiful output, however, since it uses the github api to perfectly replicate Github's rendering, you have to worry about rate-limiting.

If not, [pandoc](https://pandoc.org/index.html) can be your friend. However, getting it to produce HTML that looked attractive, preserved my site's favicon, and was mobile-friendly was a bit of a journey, so I'm recording the steps I took for future me (and anyone else who may be reading this).


Fortunately [Sindre Sorhus](https://github.com/sindresorhus) did most of the heavy lifting with the [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) project. 

What remained was to get pandoc to use that css. It's possible to export the template pandoc uses and modify using `pandoc -D html5 > template.html`. Once I did that, I modified the template file according to the [Usage](https://github.com/sindresorhus/github-markdown-css?tab=readme-ov-file#usage) instructions from the repo, adding the suggested css and wrapping pandoc's `$body$` in an `<article class="markdown-body">`.

I also wanted a standalone file, with no external dependencies (no links to external css or images). pandoc supports this via the `--standalone` flag, in combination with `--embed-resources`.

The last problem I needed to fix was a warning from pandoc: `[WARNING] This document format requires a nonempty <title> element.`. Since my markdown file used `#` to supply a title, using the title element felt redundant. I silenced the warning in a hacky way by supplying the title explicitly as a space (`title=" "`), which silenced the warning, and didn't add a redundant title to my output.

Putting it all together we have:

```bash
brew install pandoc
pandoc -D html5 > template.html
# edit the template as described above.
wget https://raw.githubusercontent.com/sindresorhus/github-markdown-css/gh-pages/github-markdown.css
pandoc -f gfm -t html5 -o README.html README.md --css github-markdown.css --embed-resources --standalone --metadata title=" " --template template.html
```
