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
short_description: Owner-authenticated Nocturne Artist Locker preview
hf_oauth: true
hf_oauth_expiration_minutes: 480
---

# Nocturne Studio — Artist Locker

Separate Hugging Face build of Nocturne Studio. Hugging Face sign-in is enabled, and the Artist Locker is restricted in the app to the owner account `ezwaypro`. The interface remains private while the sign-in gate is tested.

Artist entries are currently session-only and do not survive a restart. Durable private storage and database integration will be connected after secure storage credentials are configured. This Space does not connect to the production Nocturne database, EZway, Render, or Modal.

The Artist Locker does not request GPU time. The ZeroGPU diagnostic function is registered for later model work but is not called by the Artist Locker.
