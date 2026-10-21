# Pre-tools upgrade fixture

`pre-tools-v1.json` is a fixed synthetic export made with the schema-v1 store,
command, card, board and signing implementations at
`953e7bdde3549b03bddb8d191d8856683d1dc4c5` (before bridge tools).
It is not generated from the implementation under test or made by relabelling a
current schema-v2 document.

Clock: 2026-10-19 08:00 Asia/Shanghai. The fixture has two saved task types,
pending create/delete/replace confirmations, an unfinished recurring draft,
the original dashboard, session handle and revoked callback nonce. Cards use
the literal synthetic app secret `synthetic` and deterministic synthetic nonces.
All account, chat, actor, card and session identifiers are synthetic.

The exported draft message receipts use stable `om_old_card_*` identifiers,
and the dashboard uses `om_old_board`, matching the recorded messages.
`__WORKSPACE__` is the only installation substitution: the test replaces this
host-specific path with its real temporary workspace before loading the files.
Tests click the original signed buttons; they do not re-sign them with current
code. Keep these bytes fixed so future storage or confirmation changes cannot
silently rewrite the upgrade evidence.

`pre-tools-correction-v1.json` was exported with the same old `TurnJournal`
implementation. Its correction already has a delivery receipt but the old
message recall is unfinished. Recovery tests retain that receipt, retry or
settle the recall according to actual channel errors, and never resend the
correction. This recovery does not create new correction promises.
