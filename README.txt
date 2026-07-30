This admin panel references two image files that I didn't have access to as binary
files while building this (they weren't in the uploaded files, only referenced by
path in the original single-file dashboard):

  - assets/sound_logo.png          (used on login.html)
  - assets/verification_badge.jpeg (used as a small "Verified" icon on Job Seekers,
                                     Employers, and the biodata PDF)

Drop your existing copies of these two files into this `assets/` folder and every
page that references them will pick them up automatically — no code changes needed.

Everything that uses these already has a graceful fallback (login.html falls back to
an emoji if sound_logo.png 404s), so nothing is broken in the meantime — the badge
icon just won't render until the file is here.
