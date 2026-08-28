# How to Make a Chamber Music Log

## 1. Create the form

1. Go to [Google Forms](https://docs.google.com/forms/u/0/).

2. Create a new Form.

   ![Google Forms home page with the "+" button to create a new form](./img/howto/Screenshot%202017-05-31%2011.55.03.png){width=600px}

3. Fill it out with the questions you'd like to track. Mine looks like this:

   ![Sample form with fields for date, composer, work, players, and so on](./img/howto/Screenshot%202017-05-31%2012.17.39.png){width=600px}

## 2. Set up the response sheet

1. Click **Responses**, then the green **Sheets** button.

   ![The Responses tab in the form editor](./img/howto/Screenshot%202017-05-31%2012.05.45.png){width=600px}

   ![The Sheets button at the top of the Responses tab](./img/howto/Screenshot%202017-05-31%2012.06.20.png){width=600px}

2. Name your sheet and click **Create**.

   ![Dialog to name the response spreadsheet](./img/howto/Screenshot%202017-05-31%2012.06.30.png){width=600px}

## 3. Put the form on your phone

1. Back in the form editor, click the eyeball to preview, then click **Send**.

   ![The Send button in the form editor](./img/howto/Screenshot%202017-05-31%2012.20.59.png){width=600px}

2. In the Send dialog, click the **Link** icon and check **Shorten URL**.

   ![Send dialog showing the Link tab with the Shorten URL checkbox](./img/howto/Screenshot%202017-05-31%2012.23.34.png){width=600px}

3. Open the shortened link on your phone's browser, then choose **Add to Home Screen** from the share menu.

   ![Add to Home Screen on an iPhone](./img/howto/IMG_9796.PNG){width=280px}

## 4. Use it

1. After every piece you play, open the form from your home screen and fill it out — entries are saved straight to the response spreadsheet.

2. Play some Haydn.

3. Repeat.

## 5. Logging anything that isn't a string quartet

The three player fields model a string quartet: you take one seat, and the
other three go in **Player 1**, **Player 2**, **Player 3** — the seats your own
part implies. Playing V1 means Player 1 is V2, Player 2 is the violist, and
Player 3 is the cellist.

Piano trios, piano quartets, quintets and sextets don't fit that shape, so
there are two conventions to keep them straight.

**Use `-` for a seat the work doesn't have.** A piano trio has no second
violin and no viola, so playing violin in one looks like this:

| Which Part | Player 1 | Player 2 | Player 3 | Others? |
|---|---|---|---|---|
| `V1` | `-` | `-` | the cellist | `Alice Hart (p)` |

**Say what someone played with `(instrument)`.** Anyone whose instrument isn't
the one their seat implies needs an annotation — most often the pianist, but
also a cellist you had to seat in a violin field because the pianist took the
cello field. The annotation wins over the seat, so this is correct even though
the pianist is in the cello field:

| Which Part | Player 1 | Player 2 | Player 3 | Others? |
|---|---|---|---|---|
| `V1` | the violist `(va)` | the cellist `(vc)` | the pianist `(p)` | |

Both spellings and shorthands work — `p`, `pf` and `piano` are the same thing,
as are `vc` and `cello`, and `va`, `vla` and `viola`. You can add a comment
after the instrument: `Alice Hart (vc, doubling)` keeps the `vc` and ignores
the rest. Parentheses that name no instrument — `(sub)`, `(guest)`, `(first
time)` — are just notes: they're ignored, and the seat decides as usual.

Pianists, clarinettists and other non-string players are counted as people you
played with, but they're left out of the V1/V2/VA/VC part breakdowns, which
only make sense for string parts.

You can also put the extra player in **Others?** instead — `Alice Hart (p)`
there is read the same way. One difference decides which to reach for: the
player fields carry forward to the next entry in a session, so a slot you
leave blank repeats whoever was there before, annotation included. **Others?
does not carry forward.** Logging six movements with the pianist in Others?
means typing them six times, while `Alice Hart (p)` in a player field is typed
once. Put them in a player field for a long session, and in Others? when the
seats are already full — a piano quintet, say, where four string players fill
every slot.

## 6. What repeats itself, and what doesn't

You don't have to retype the same four names for every piece. Leave a player
field **blank** and it repeats whoever was in that seat on your last entry —
annotation included, so `Alice Hart (p)` keeps the `(p)`. Typing a short form
of the name that's already there does the same: `Alice` after `Alice Hart`
means the same person, not a new one.

Three things are worth knowing, because they're the difference between a log
that reads correctly years later and one that doesn't.

**It repeats field by field.** When one player swaps out mid-session, type the
new name in that one field and leave the others blank. The seats you left
alone keep their people. This is what makes a long afternoon of rotating
personnel easy to log — you only ever type what changed.

**Only the player fields and the location repeat. `Others?` does not.** A
fifth or sixth player has to be typed on every row they played. This is the
single most common way a person goes missing from the log, and it's what
`npm run audit` looks for first.

**A long gap breaks the chain.** Repeating only reaches back a few hours, so a
blank field after a dinner break has nothing to repeat and stays empty — and
so does every blank row after it, until you type a name again. It's the gap
between two entries that matters, not how long you've been playing: an
all-day session logged as you go is fine however long the day runs. If you
come back after a real break, **type the names once** on the first piece of
the new sitting. One line of typing protects the rest of the evening.

## 7. Naming people

**Type someone's full name the first time you log them.** After that, whatever
you naturally type is fine — first name, nickname, whatever the group calls
them.

The reason is that a first name stops identifying one person the moment a
second Alice turns up, and by then the older entries have no surname to tell
them apart. Reconstructing that later means cross-referencing dates, venues and
who else was in the room, and it gets harder every month. Spending three extra
seconds once is the whole fix.

Short forms are still worth using for the people you play with constantly —
you will never wonder who "Bob" was. The rule is only about the first entry
for someone new.

## 8. View your log

1. In your response sheet, go to **File → Share → Publish to web**. Set the format to **Comma-separated values (.csv)** and click **Publish**. Copy the URL it gives you.

   ![Publish to web dialog with CSV format selected](./img/howto/publish-to-web.png){width=600px}

2. Open <https://log.quartetroulette.com/> and paste the published-CSV URL into the setup screen.

3. From then on, the site reads your sheet on each visit, so new sessions you log will show up the next time you reload.
