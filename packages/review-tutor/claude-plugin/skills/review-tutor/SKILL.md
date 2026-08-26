---
name: review-tutor
description: Open the Review Tutor for a review, PR, diff, or commit in your browser.
disable-model-invocation: true
allowed-tools: Bash(npx -y @pickforge/review-tutor *)
---

Review Tutor starts locally and prints its browser session URL.

!`npx -y @pickforge/review-tutor $ARGUMENTS --detach`

The URL above is a one-time session link on 127.0.0.1; open it in your browser. Nothing from this conversation is sent to the tutor.
