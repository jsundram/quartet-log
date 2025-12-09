# TODO:
* add an "Other" tab containing just a datatable of everything that wasn't in the other tabs.
* Update work rows to link to quartet roulette (currently slug is in tooltip which is hard to use)
* Remove K546 (adagio and fugue)?
* Add colored indicator for each row showing how long it's been?
* Add a hit counter? https://github.com/abdheshnayak/static-website-views-counter
* Add RSS for playing feed?
* Revisit colors?
    * http://vrl.cs.brown.edu/color
    * https://projects.susielu.com/viz-palette
    * https://www.learnui.design/tools/data-color-picker.html

## DONE
* Add a radio button for "Any"?
* Actually visualize the data (group opuses etc)
* initial composer selection = Haydn
* Nicer tooltip
* Tab Appearance
    * Make active tab more obvious
    * Make tabs look more tab-like
* Add all quartets, whether played or not
* Deploy this to viz.runningwithdata.com/musiclog && update main site index.
* condense date label for sliders to fit on one line. (.toLocaleDateString() instead of toDateString())
* Consider setting initial slider value to 1 year ago.
* Make slider increment in nice dates
* Add total count of quartets played per view
* Add random button that takes into account whether something has been played recently.
* default slider to starting 1YA
* pull in d3v7 dependency for future-proofing
* favicon? / safari icon:
    * use violin emoji!
        * https://css-tricks.com/emoji-as-a-favicon/
        * https://codepen.io/chriscoyier/project/editor/ZeWQWJ
    * decide not to use css-tricks, and just upload a capture of the moji to https://realfavicongenerator.net/
    * check favicon perf here:
        * https://realfavicongenerator.net/favicon_checker?protocol=http&site=viz.runningwithdata.com%2Fmusiclog%2Findex.html
* hover/highlight effect for selected square
* keep tooltips on the screen
* Add Calendar view (https://observablehq.com/@d3/calendar/2?)
* Add sessions/year and quartets/year to calendar view
* Max calendar session shows 18 works played ... it happened!
* pandoc md -> html conversion doesn't look good on mobile
    * try https://github.com/sindresorhus/github-markdown-css
    * write a quick note about it, [md_to_html.md](./md_to_html.html)
* Month dividing lines don't stretch through the whole 7-day week. Fixed in `pathMonth`
* Add legend to calendar view: https://observablehq.com/@d3/color-legend
* revisit color mapping for calendar view.
* Add tooltip to calendar view
* Show last played date on hover on title when non shown, with filters applied
* Show tooltip even if unplayed
* Add Schumann / Brahms
* Make spacing more compact on mobile, fix start text getting cropped.
* Fix bug showing non-quartets for Schumann / Brahms / Shostakovich.
* Add caching with localstorage in case of network unavailability etc.
* Show timestamp of last data and last playing date on main page.
* change update.sh to create a local copy of what is going to be deployed for easier diffing in future
* create git repo
* split things into separate files for easier updates
    * viz.js for javascript
    * viz.css for css (requires updating update.sh)
    * change update.sh to create a folder "deploy" that has everything in it.
        * favicons can be copied from a subfolder into the root [as recommended](https://realfavicongenerator.net/faq)
    * move favicon files to their own folder
        * requires updating update.sh and snapshot.sh
* Update generated md html to use the same background color for the whole window
* Add Mendelssohn & Dvorak
* add "days since" last play.
* Add sortable data table for each tab
* there's a sort state bug across tabs that could use some fixing...
* make sorting by work title use work.catalog & int(work.number) instead of strcmp title.
* less padding / spacing on datatable rows
* Add Search/Dropdown to filter for frequent collaborators
* Add a "Rare" tab and include:
    * Prokofiev 1/2
    * Britten 1/2/3?
    * Debussy
    * Grieg
    * Ravel
    * Smetana
    * Tchaikovsky 1/2/3?
    * Verdi
