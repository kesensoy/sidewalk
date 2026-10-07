<!--
  The same text is site/privacy.html, which is what https://sidewalk.sh/privacy
  serves and what both store listings link to. Change one and change the other;
  there is no build step between them.
-->

# Privacy policy

**sidewalk** is a browser extension. It shows cards written by an AI agent in
a side panel beside the page they are about, and sends your answers to that
agent.

It talks to one program: `walkd`, which you install and run on your own
machine, at `127.0.0.1`. There is no sidewalk server, no account, and no
analytics. Nothing is sent anywhere else.

## What an answer carries

What you typed and pressed, the address of the page you were on, recent
console errors and warnings from that page, the text of one page element when
a card asks for it to be checked, and a screenshot of the visible tab. Under
the gear you can limit screenshots to issues, or turn them off. All of it goes
to `walkd` on your machine.

## What is stored

In your browser: the daemon's port and token, the pane's settings, how far
you have read, and an answer that is waiting to be sent.

On your disk, written by `walkd` under your own user's data folder: the walk,
your answers, and their screenshots. Nothing is written into the project you
are walking.

## Secrets on a card

A card can carry a value for you to paste. `walkd` holds it in memory and
does not write it to the record or into the page. Once you press Copy it is on
your clipboard like anything else you copy. `walkd` answers only a caller that
has its token, and a program that can read your files can read the token. Use
demo keys and test accounts.

## Permissions

Side panel, for the pane. Tabs and all sites, because a card can point at any
address and the screenshot needs them. Active tab, so the screenshot still
works on the page in front of you if you narrow the site access. Scripting, to check what a card names on the page, outline it when you press Go, and collect console lines.
Storage, for the items above. Alarms, to look
for `walkd`. Clipboard write on Firefox, for the Copy button.

## Questions

Open an issue at [github.com/kesensoy/sidewalk/issues](https://github.com/kesensoy/sidewalk/issues).
This policy lives with the code and changes with it.
