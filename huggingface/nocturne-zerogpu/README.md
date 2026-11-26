---
title: Nocturne Studio
emoji: 🎬
colorFrom: purple
colorTo: gray
sdk: gradio
sdk_version: "6.32.0"
app_file: app.py
python_version: "3.12"
startup_duration_timeout: 30m
short_description: Owner-authenticated Nocturne Artist Locker
hf_oauth: true
hf_oauth_expiration_minutes: 480
---

# Nocturne Studio — Artist Locker

Separate Hugging Face build of Nocturne Studio. Hugging Face sign-in is enabled, and the Artist Locker is restricted in the app to the owner account `ezwaypro`.

Artist names, visual notes, and reference portraits are saved to the separate private dataset `ezwaypro/nocturne-artist-locker`. The Space requires an `HF_TOKEN` secret with write access to that private dataset. Add the token under Space Settings → Variables and secrets → New secret (name: `HF_TOKEN`). Never paste the token into chat or commit it to GitHub.

This Space does not connect to production Nocturne, EZway, Supabase, Render, or Modal. Artist Locker actions do not request GPU time; ZeroGPU is reserved for future model features.
