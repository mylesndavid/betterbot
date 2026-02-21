# Building a Custom Handheld AI Device (Rabbit R1-style)

Research compiled 2026-02-21. Goal: build a pocket-sized device with screen, mic, speaker, and scroll wheel that runs the Raya agent framework (Node.js).

---

## 1. Hardware Platforms / SBCs

### Raspberry Pi Family

#### Raspberry Pi Zero 2 W
- **What:** Quad-core ARM Cortex-A53 at 1GHz, 512MB RAM, WiFi/BT, in a tiny 65x30mm form factor. ~$15.
- **Why:** Cheapest viable option. The "Chatbot Zero" project proved it can run an AI chatbot with STT/TTS. Limited by 512MB RAM -- fine if Raya offloads LLM calls to cloud APIs (which it does via OpenRouter).
- **Link:** https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/

#### Raspberry Pi 5
- **What:** Quad-core ARM Cortex-A76 at 2.4GHz, up to 16GB RAM, WiFi 5, BT 5.0. ~$60-$80.
- **Why:** Massively more capable than Zero 2 W. Can run Whisper.cpp and Piper TTS locally. Overkill for a pocket device but excellent for prototyping before miniaturizing.
- **Link:** https://www.raspberrypi.com/products/raspberry-pi-5/

#### Raspberry Pi Compute Module 4 / 5
- **What:** The Pi SoC on a SODIMM-style module, designed to plug into custom carrier boards. CM4 has the same BCM2711 as Pi 4; CM5 uses the BCM2712 (Pi 5 chip).
- **Why:** Lets you design a custom carrier board with exactly the peripherals you need (display connector, mic, speaker amp, battery charging, scroll wheel encoder). The official CM4IO board is open-source KiCad, so you can fork it.
- **Links:**
  - CM4: https://www.raspberrypi.com/products/compute-module-4/
  - CM4IO open-source design: https://www.digikey.com/en/maker/projects/creating-a-raspberry-pi-compute-module-4-cm4-carrier-board-in-kicad/7812da347e5e409aa28d59ea2aaea490

### ESP32-S3 Based

#### LILYGO T-LoRa Pager
- **What:** ESP32-S3 handheld with QWERTY keyboard, 2.33" IPS strip display (222x480), rotary encoder with push button, LoRa radio, 6-axis IMU, speaker, and microphone. ~$35-50.
- **Why:** Closest off-the-shelf form factor to the R1. Already has a rotary encoder (scroll wheel), display, mic, speaker. Could act as a BLE/WiFi thin client sending audio to a Pi or server running Raya.
- **Link:** https://www.tindie.com/products/lilygo/t-lora-pager-esp32-s3-lora-handheld-aiot-device/

#### Waveshare ESP32-S3 Touch LCD 3.5"
- **What:** ESP32-S3 dev board with a 3.5" capacitive touchscreen (320x480), camera interface, WiFi, BLE. ~$20.
- **Why:** Cheap way to prototype the UI. ESP32-S3 can handle wake word detection and stream audio over WiFi to a server running Node.js/Raya.
- **Link:** https://www.waveshare.com/esp32-s3-touch-lcd-3.5.htm

#### Seeed Studio XIAO ESP32S3 Sense
- **What:** Thumb-sized ESP32-S3 module with built-in camera, digital microphone, and SD card. ~$14.
- **Why:** Extremely compact. Pair it with the Seeed Round Display (1.28" touch, 240x240) for a smartwatch-like AI device. Great for a wearable form factor.
- **Links:**
  - Board: https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html
  - Round Display: https://www.seeedstudio.com/Seeed-Studio-Round-Display-for-XIAO-p-5638.html

#### Keyestudio ESP32-S3 AI Chatbot Kit
- **What:** Breadboard-friendly ESP32-S3 kit with 1.54" display, microphone, and speaker designed specifically for building AI chatbots (DeepSeek, etc.).
- **Why:** Cheapest possible starting point to prototype voice interaction. Not pocket-ready out of the box, but great for experimenting.
- **Link:** https://www.keyestudio.com/products/keyestudio-esp32-s3-al-chatbot-breadboard-diy-kit-with-154-inch-display-screen-al-voice-assistant-starter-kit-for-deepseek

### Android/Linux SBCs

#### Radxa Cubie A7Z
- **What:** Pi Zero-sized SBC with Allwinner A733 octa-core (Cortex-A76/A55), up to 16GB RAM, WiFi 6, built-in NPU. ~$30+.
- **Why:** Significantly more powerful than Pi Zero 2 W in the same form factor. 16GB RAM means it could run local small LLMs. NPU enables on-device inference.
- **Link:** https://www.cnx-software.com/2025/08/25/pi-zero-sized-radxa-cubie-a7z-sbc-features-allwinner-a733-cortex-a76-a55-soc-up-to-16gb-ram-wifi-6/

#### Radxa Zero 2 Pro
- **What:** Amlogic-based SBC with integrated NPU (5 TOPS), runs Android and Linux, Pi Zero form factor.
- **Why:** The NPU makes it viable for on-device wake word detection and possibly small model inference. Runs Android natively.
- **Link:** https://radxa.com/products/zeros/zero/

#### Particle Tachyon
- **What:** Credit-card-sized SBC with Qualcomm Dragonwing platform (octa-core Kryo CPU, Adreno 643 GPU), 5G cellular, AI acceleration.
- **Why:** Production-grade board with cellular connectivity -- no need for WiFi tethering. Qualcomm means strong Android support.
- **Link:** https://www.notebookcheck.net/Particle-Tachyon-SBC-debuts-with-Snapdragon-chip-for-handling-on-device-AI-tasks.870092.0.html

#### Radxa Dragon Q6A
- **What:** SBC using Qualcomm QCS6490 with mainline support for CPU, GPU, and Hexagon NPU. Starting at $69.90.
- **Why:** Full Qualcomm Android stack with NPU support. The QCS6490 is designed for AI-at-the-edge devices.
- **Link:** https://sbcwiki.com/news/articles/state-of-embedded-q4-25/

---

## 2. Display + Touch Options

### TFT/IPS Screens

#### Pimoroni HyperPixel 4.0
- **What:** 4.0" IPS display, 800x480, 60fps, capacitive multi-touch. Plugs directly onto Pi GPIO header via high-speed DPI interface.
- **Why:** High quality display with touch. Bit large for pocket device but great for prototyping.
- **Link:** https://shop.pimoroni.com/products/hyperpixel-4

#### Pimoroni HyperPixel 2.1 Round
- **What:** 2.1" round IPS touchscreen, high-res, capacitive touch, DPI interface. Fits on Pi Zero.
- **Why:** Unique round form factor. Could create a very distinctive device aesthetic (smartwatch-meets-R1).
- **Link:** https://shop.pimoroni.com/en-us/products/hyperpixel-round

#### Waveshare 2.8" / 3.5" SPI TFT Displays
- **What:** Budget SPI-connected TFT displays in various sizes. Touch versions available. ~$10-20.
- **Why:** Cheap, widely available, well-documented with Raspberry Pi. SPI is slower than DPI but sufficient for a text/status UI.
- **Link:** https://www.waveshare.com/esp32-s3-touch-lcd-3.5.htm

#### Seeed Studio Round Display for XIAO
- **What:** 1.28" round capacitive touchscreen, 240x240, 65K colors. Designed for XIAO ESP32 boards. ~$18.
- **Why:** Tiny, elegant, perfect for a compact wearable or pendant-style device.
- **Link:** https://www.seeedstudio.com/Seeed-Studio-Round-Display-for-XIAO-p-5638.html

### E-Ink Displays

#### Waveshare 2.9" E-Ink Touch Display HAT
- **What:** 2.9" e-paper with 5-point capacitive touch, 296x128, black/white, SPI, designed as a Pi HAT.
- **Why:** Ultra-low power, sunlight readable. Touch support makes it interactive. Perfect for a device that mostly shows text status. Battery life would be excellent.
- **Link:** https://www.waveshare.com/2.9inch-touch-e-paper-hat.htm

#### Waveshare 2.9" Flexible E-Ink
- **What:** Bendable e-paper display, 296x128, can conform to curved enclosures.
- **Why:** Could wrap around a cylindrical or curved device body for a unique form factor.
- **Link:** https://www.amazon.com/Waveshare-2-9inch-Resolution-Controller-Interface/dp/B07SYQ6MBC

---

## 3. Audio Hardware

### All-in-One HATs

#### PiSugar Whisplay HAT
- **What:** Expansion board for Pi Zero with 1.69" LCD (240x280), WM8960 audio codec, dual MEMS microphones, onboard speaker, RGB LEDs, and GPIO buttons. ~$25.
- **Why:** This is the single best starting point. One HAT gives you display + mic + speaker + buttons on a Pi Zero. The "Chatbot Zero" project uses exactly this. Add a PiSugar battery and you have a complete device.
- **Links:**
  - Product: https://www.pisugar.com/products/whisplay-hat-for-pi-zero-2w-audio-display
  - Docs: https://docs.pisugar.com/docs/product-wiki/whisplay/overview
  - Chatbot Zero project: https://github.com/PiSugar/whisplay-ai-chatbot

#### WM8960 Audio HAT
- **What:** I2S audio codec HAT with dual microphones, speaker output, 3.5mm jack. Works with Pi Zero and Pi 4/5. ~$10-15.
- **Why:** If you want a separate (larger) display, this gives you just the audio. Dual mics enable noise cancellation.
- **Link:** https://www.amazon.com/Decoder-Recognition-Micphone-Interface-Raspberry/dp/B0982BCPFH

#### Raspberry Pi Codec Zero
- **What:** Official Pi Zero-sized audio HAT with Dialog DA7212 codec, bi-directional I2S audio.
- **Why:** Official Raspberry Pi product, well-documented, exact same size as Pi Zero.
- **Link:** https://www.raspberrypi.com/documentation/accessories/audio.html

### Standalone Components

#### Adafruit I2S MEMS Microphone Breakout (SPH0645LM4H)
- **What:** Tiny I2S digital microphone breakout, 50Hz-15KHz range. ~$7.
- **Why:** Can be soldered directly into a custom build. I2S means no analog noise. Well-documented for Pi.
- **Link:** https://learn.adafruit.com/adafruit-i2s-mems-microphone-breakout/raspberry-pi-wiring-test

#### Waveshare ESP32-S3 Audio Board
- **What:** ESP32-S3 board with dual microphone array, noise reduction, echo cancellation, surround RGB lighting.
- **Why:** If using ESP32 as audio frontend, this handles the full audio pipeline with hardware echo cancellation.
- **Link:** https://www.waveshare.com/esp32-s3-audio-board.htm

---

## 4. Enclosure / Form Factor

### 3D Printed Enclosures

#### Deckility Handheld PC
- **What:** 3D-printed Pi handheld with sliding display mount, integrated keyboard, 5" touchscreen, dual 18650 batteries (6hr life). Full OnShape CAD files available.
- **Why:** Open-source mechanical design you can fork and modify. The sliding display concept could be adapted for a simpler R1-like form.
- **Links:**
  - Overview: https://www.raspberrypi.com/news/deckility-handheld-pc-magpimonday/
  - Tom's Hardware: https://www.tomshardware.com/news/raspberry-pi-decktility-handheld

#### Adafruit Mini Pi Handheld Notebook
- **What:** 3D-printed enclosure turning a Pi + 3.5" PiTFT into a retro palmtop. Full build guide with STL files.
- **Why:** Well-documented Adafruit guide with downloadable STL files. Good starting point to modify for an R1-style form factor.
- **Link:** https://learn.adafruit.com/mini-raspberry-pi-handheld-notebook-palmtop/overview

#### Yeggi / Thingiverse Search
- **What:** 3D model repositories with hundreds of "Raspberry Pi handheld" designs.
- **Why:** Browse existing designs for inspiration or find one close to the R1 form factor to modify.
- **Link:** https://www.yeggi.com/q/raspberry+pi+handheld/

### Pre-Made Kits

#### SpecFive Strike
- **What:** Handheld Linux computer with CM4, custom carrier board, 4.3" touchscreen, QWERTY keyboard, LoRa mesh radio. Available on Etsy.
- **Why:** Ready-made handheld with a CM4. Could potentially swap in your own software stack.
- **Link:** https://www.etsy.com/listing/4376379642/specfive-strike-handheld-linux-computer

#### CrowPi 3
- **What:** Raspberry Pi 5-powered portable learning platform with 4.3" touchscreen, 30+ sensors/modules, breadboard area. ~$229-$489.
- **Why:** Not pocket-sized, but an excellent prototyping platform with integrated display, sensors, and power management. Good for developing the software before miniaturizing.
- **Link:** https://www.crowpi.cc/

### Design Inspiration

The Rabbit R1 was designed by Teenage Engineering (the Swedish design firm behind the OP-1 synthesizer). There are no open-source R1 enclosure files, but the R1's dimensions are approximately 78mm x 78mm x 13mm -- a compact square. For reference, a Pi Zero 2 W (65x30mm) plus Whisplay HAT could fit in a similar footprint with a 3D-printed shell.

---

## 5. Software / OS Options

### Linux Distributions

#### Raspberry Pi OS Lite
- **What:** Official minimal Debian-based OS for Pi. Headless or with lightweight desktop.
- **Why:** Most straightforward option. Run Node.js + Raya directly. Use framebuffer or a lightweight toolkit (e.g., SDL2, LVGL) for the display UI.
- **Link:** https://www.raspberrypi.com/software/

#### PostmarketOS
- **What:** Alpine Linux-based OS designed for phones and portable devices. Supports Phosh, KDE Plasma Mobile, and other mobile UIs.
- **Why:** Mobile-optimized Linux with touch UI. Designed for exactly this kind of device. Lightweight.
- **Link:** https://postmarketos.org/

#### Mobian
- **What:** Debian for phones. Supports PinePhone, Pixel 3a, OnePlus 6. Available with Phosh or KDE Plasma Mobile.
- **Why:** Full Debian ecosystem (apt install node.js) with a phone-optimized UI.
- **Link:** https://www.theregister.com/2025/10/21/mobian_trixie/

### Android Options

Android can run on several SBCs (Radxa boards, Banana Pi, etc.). You would run Node.js via Termux or a custom Android app that shells out to the Raya process. The Qualcomm-based boards (Particle Tachyon, Radxa Dragon Q6A) have the best Android support.

### Voice Pipeline Architecture

The recommended voice pipeline for Raya:

```
[Wake Word] -> [STT] -> [Raya Agent] -> [TTS] -> [Speaker]
```

#### Wake Word Detection
- **OpenWakeWord** -- open-source, runs on Pi, customizable wake words
- **Porcupine by Picovoice** -- lightweight, runs on ESP32, free tier available

#### Speech-to-Text (STT)
- **Whisper.cpp** -- OpenAI Whisper ported to C++, runs on Pi 5 in under 1 second. Use `tiny` or `base` model on Pi Zero.
  - https://github.com/ggerganov/whisper.cpp
- **Vosk** -- Lightweight offline STT, good for Pi Zero. Multiple language models.
  - https://alphacephei.com/vosk/

#### Text-to-Speech (TTS)
- **Piper** -- Fast, local neural TTS by the Rhasspy team. Runs on Pi 4/5 in real-time. Many voice models available.
  - https://github.com/rhasspy/piper
- **espeak-ng** -- Ultra-lightweight TTS, robotic but runs on anything.

#### Full Pipeline Projects
- **Wyoming Protocol (Home Assistant)** -- Standardized protocol connecting wake word, STT, and TTS services. Can be used standalone.
  - https://www.home-assistant.io/integrations/wyoming/
- **TrooperAI** -- Complete local voice assistant for Pi 5 with LED, gesture control, streaming LLM replies.
  - https://github.com/m15-ai/TrooperAI
- **risvn/voice-assistant** -- Real-time offline voice-to-voice AI assistant built specifically for Raspberry Pi.
  - https://github.com/risvn/voice-assistant

---

## 6. Existing Open-Source Projects

### Voice Assistants

#### Open Voice OS (OVOS)
- **What:** Community continuation of Mycroft, the open-source voice assistant. Full-featured voice OS with skills, plugins, and hardware support. Apache 2.0 license.
- **Why:** Most mature open-source voice assistant platform. Could run alongside or integrate with Raya for voice pipeline management.
- **Link:** https://www.openvoiceos.org/

#### The 01 Project (Open Interpreter)
- **What:** Open-source voice interface for desktop, mobile, and ESP32. The "01 Light" is an ESP32-based voice device that connects to a server running Open Interpreter.
- **Why:** Closest open-source project to the R1 concept. The ESP32 Light hardware design could be adapted, and the voice pipeline architecture is well-documented.
- **Link:** https://github.com/openinterpreter/01

#### MimiClaw
- **What:** OpenClaw-inspired AI assistant for ESP32-S3 boards. Acts as a Telegram-to-Claude gateway with hardware control.
- **Why:** Directly inspired by Rabbit's OpenClaw. Demonstrates running a Claude-based agent on ESP32-S3 hardware.
- **Link:** https://www.cnx-software.com/2026/02/13/mimiclaw-is-an-openclaw-like-ai-assistant-for-esp32-s3-boards/

### Rabbit R1 Clones / Inspired

#### Chatbot Zero
- **What:** Pocket-sized AI chatbot on Pi Zero 2W with Whisplay HAT. Press button, speak, get AI response. ~$50 total cost.
- **Why:** This is the closest existing project to what you want to build. Fork this repo, replace the LLM backend with Raya, and iterate on the enclosure.
- **Links:**
  - Project: https://hackaday.io/project/203317-chatbot-zero-ai-on-raspberry-pi-zero
  - GitHub: https://github.com/PiSugar/whisplay-ai-chatbot

#### Hamster H1
- **What:** Open-source alternative to Rabbit R1. Aims to build all features using open-source LLMs and DIY hardware.
- **Why:** Community effort specifically targeting R1 feature parity with open-source tools.
- **Link:** https://github.com/harigovind511/hamster-h1

#### AI-Rabbit-R1 (FantasyFish)
- **What:** Open-source "language model computer" inspired by the R1.
- **Why:** Another community R1 clone attempt with code on GitHub.
- **Link:** https://github.com/FantasyFish/AI-Rabbit-R1

### Wearable AI

#### Omi (formerly Friend)
- **What:** Open-source AI wearable necklace. Uses Seeed XIAO nRF52840 Sense ($15), records audio 24h+ on button battery, transcribes via BLE to phone app. Full hardware + software on GitHub.
- **Why:** If you want a wearable companion to the handheld (or a simpler v1), this is the cheapest and most documented open-source AI wearable. Hardware BOM is ~$20.
- **Link:** https://github.com/BasedHardware/omi

#### ADeus
- **What:** Open-source AI wearable that captures what you say and hear, transcribes and stores it on your own server. Chat interface with full context.
- **Why:** Privacy-focused design aligns with Raya's philosophy. Server-side architecture means the wearable can be minimal.
- **Link:** https://github.com/adamcohenhillel/ADeus

#### OpenPin / PenumbraOS
- **What:** Open-source project to revive the Humane AI Pin. PenumbraOS is a custom OS with a modular assistant (MABL) supporting pluggable LLM, STT, and TTS backends. ~400 hours of reverse engineering.
- **Why:** If you can get a cheap bricked AI Pin (~$50-100 on eBay), PenumbraOS turns it into a dev platform with display, mic, speaker, camera, and cellular in a tiny wearable form factor.
- **Links:**
  - OpenPin: https://github.com/MaxMaeder/OpenPin
  - PenumbraOS: https://github.com/PenumbraOS
  - PenumbraOS SDK: https://github.com/PenumbraOS/sdk

### ESP32 Voice Assistants

#### ElatoAI
- **What:** End-to-end platform for deploying AI voice agents on ESP32-S3. Uses Deno edge server to bridge hardware with OpenAI, Gemini, and ElevenLabs APIs.
- **Why:** Deno/TypeScript server-side is close to the Node.js world. Could be adapted to call Raya instead of generic LLM APIs.
- **Link:** https://osrtos.com/projects/elatoai-realtime-voice-ai-on-esp32/

#### KALO ESP32 Voice Chat
- **What:** ESP32 voice chat with I2S mic, I2S speaker, multiple custom AI bot personalities. Published PCB source and Gerber files.
- **Why:** Full hardware design files (PCB + Gerber) available. Records with I2S mic, transcribes via Deepgram/ElevenLabs STT, sends to Groq/OpenAI, plays TTS response.
- **Link:** https://github.com/kaloprojects/KALO-ESP32-Voice-Chat-AI-Friends

---

## 7. Even Realities G1 Glasses Integration

### Official SDK / Developer Resources

#### EvenDemoApp
- **What:** Official demo app from Even Realities demonstrating G1 glass connectivity. Dual Bluetooth (one BLE connection per arm), supports recording audio, transmitting text and images, and displaying content on the glasses.
- **Why:** Primary resource for understanding the G1 communication protocol. Each arm is a separate BLE connection -- important architectural detail.
- **Link:** https://github.com/even-realities/EvenDemoApp

#### Even Hub SDK (G1/G2)
- **What:** High-level SDK from Even Realities for building apps. Handles hardware details, quick setup, local dev support.
- **Why:** Official supported path for building custom G1 apps.
- **Link:** https://evenhub.evenrealities.com/

### Third-Party Platforms

#### AugmentOS
- **What:** Open-source smart glasses OS (MIT license). Write one TypeScript app that works across Even G1, Mentra, Vuzix, and more. Handles pairing, connection, data streaming, cross-compatibility. TypeScript SDK.
- **Why:** This is the best path for Raya integration. Write a TypeScript AugmentOS app that connects to Raya, displays responses on the G1 lenses, and uses the G1 mic for voice input. One codebase, multiple glass platforms.
- **Links:**
  - Main site: https://augmentos.org/even/
  - GitHub: https://github.com/AugmentOS-Community/AugmentOS

#### Gadgetbridge
- **What:** Open-source Android app for managing Bluetooth wearables without vendor apps. Has Even Realities G1 support.
- **Why:** Alternative to the official Even G1 app. Could be used to route G1 data to a custom Android app running Raya.
- **Link:** https://gadgetbridge.org/gadgets/others/even_realities/

#### awesome-even-realities-g1
- **What:** Curated list of G1 projects, tools, and resources maintained by the community.
- **Why:** One-stop reference for everything G1-related.
- **Link:** https://github.com/galfaroth/awesome-even-realities-g1

### G1 as Raya Display/Input

The G1 glasses can serve as both a heads-up display and audio input for Raya:
- **Display:** Send text, simple graphics, or notification cards to the G1 lenses via BLE
- **Microphone:** The G1 has a built-in mic; audio can be streamed to a phone/device running Raya
- **Architecture:** Phone/Pi runs Raya agent + AugmentOS app. G1 connects via BLE. User speaks into G1 mic -> audio streamed to Raya -> response displayed on G1 lenses and/or spoken through G1 speaker or phone speaker.

---

## 8. Recommended Build Paths

### Path A: Fastest Prototype (~$50, 1 weekend)
- **Pi Zero 2 W** + **PiSugar Whisplay HAT** + **PiSugar battery**
- Fork the Chatbot Zero repo, replace LLM backend with Raya
- 3D print a simple rectangular enclosure
- Add a rotary encoder to GPIO for scroll wheel

### Path B: Better Hardware (~$100-150, ESP32 thin client)
- **LILYGO T-LoRa Pager** (already has display, scroll wheel, mic, speaker)
- ESP32 handles wake word + audio streaming over WiFi
- Pi 5 or home server runs Raya, Whisper.cpp, and Piper
- Design a slimmer 3D-printed shell

### Path C: Full Custom (~$150-300)
- **Raspberry Pi CM4/CM5** on a custom carrier board
- **Pimoroni HyperPixel 2.1 Round** or 2.8" IPS touch display
- **WM8960 audio codec** with dual MEMS mics + small speaker
- Rotary encoder + push button
- LiPo battery with charging circuit
- Full custom 3D-printed enclosure, R1-inspired design
- Runs Pi OS Lite + Node.js + Raya + Piper + Whisper.cpp

### Path D: Glasses-First (~$0 additional, software only)
- Use the **Even Realities G1** you already own
- Build an AugmentOS TypeScript app that connects to Raya
- Phone in pocket runs the Raya agent
- Voice in via G1 mic, response displayed on G1 lenses
- No new hardware needed, pure software project

---

## 9. Key Takeaways

1. **The Whisplay HAT + Pi Zero 2 W is the fastest path** to a working prototype. The Chatbot Zero project has already solved the hard integration problems.

2. **ESP32-S3 makes a great thin client** but cannot run Node.js natively. Use it as an audio/display frontend that streams to a server running Raya.

3. **The Even Realities G1 + AugmentOS is an underexplored opportunity.** You already own the hardware. An AugmentOS TypeScript app could give Raya a heads-up display today.

4. **For a true R1-like device, a CM4/CM5 custom carrier board is the endgame.** But start with Path A or D to validate the UX before investing in custom PCB design.

5. **Voice pipeline is a solved problem.** Whisper.cpp (STT) + Piper (TTS) + OpenWakeWord run well on Pi 5. On Pi Zero 2 W, offload STT/TTS to a server or use cloud APIs.

6. **Battery life will be the main challenge.** The Pi Zero 2 W draws ~0.5-1W idle. With a 3000mAh LiPo, expect 4-8 hours. ESP32 thin client approach would give much better battery life (days).
