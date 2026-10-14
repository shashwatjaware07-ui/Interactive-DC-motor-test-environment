# Project Blueprint: Interactive DC Motor Testing & Control Simulator (PS 3)

## 1. Role & Objective
Act as a Principal Frontend Architect and Electrical Engineering Simulation Specialist. Build an interactive, industrial-grade, web-based simulation of a **Separately Excited DC Motor Test Bench** using pure **HTML5, CSS3, and Vanilla JavaScript**.

The application must look like a modern, high-precision digital twin / SCADA laboratory interface (inspired by NI LabVIEW, Siemens WinCC, and Fluke digital instrumentation) and satisfy all 8 problem statement requirements with realistic physics, dynamic animations, real-time plotting, and automated lab data logging[cite: 3, 4].

---

## 2. Core Problem Statement Requirements Checklist
Every single one of these features must be prominently implemented and interactive:
1. **Field Control:** Precision slider + numeric input to adjust Field Current ($I_f$) and observe inverse effects on motor speed ($N$) and direct effects on torque ($\tau$)[cite: 3].
2. **Armature Control:** Precision slider + numeric input to vary Armature Voltage ($V_a$) and study its effect on motor speed ($N$) and Armature Current ($I_a$)[cite: 3].
3. **Live Parameter Display:** High-contrast digital telemetry cards + circular SVG gauges showing[cite: 3]:
   - Motor Speed ($N$) in RPM[cite: 3]
   - Armature Current ($I_a$) in Amps (A)[cite: 3]
   - Field Current ($I_f$) in Amps (A)[cite: 3]
   - Armature Voltage ($V_a$) in Volts (V)[cite: 3]
   - Electromagnetic / Shaft Torque ($\tau$) in Nm[cite: 3]
   - Input Electrical Power ($P_{in}$) in Watts (W)[cite: 3]
   - *Bonus Telemetry for Victory:* Back EMF ($E_b$ in V), Copper Losses ($P_{cu}$ in W), and Efficiency ($\eta$ in %).
4. **Load Control:** Interactive Pony Brake / Dynamometer Load slider ($\tau_{load}$ in Nm) with quick preset buttons (*No Load*, *25%*, *50%*, *Full Load*, *Overload Stall*) to observe changes in speed, current, and torque[cite: 3].
5. **Real-Time Graphs:** Interactive multi-tabbed Chart.js (or custom HTML5 Canvas) oscilloscope/plotter with live operating point tracking and characteristic curve plotting for[cite: 3]:
   - Graph A: Speed ($N$) vs. Armature Voltage ($V_a$)[cite: 3]
   - Graph B: Speed ($N$) vs. Field Current ($I_f$) — clearly demonstrating the hyperbolic flux-weakening curve[cite: 3]
   - Graph C: Armature Current ($I_a$) & Speed ($N$) vs. Mechanical Load ($\tau_{load}$)[cite: 3]
6. **Motor Behaviour Visualiser:** Interactive HTML5 Canvas / SVG animated cross-section and shaft view of the DC motor coupled to a dynamometer load[cite: 3]:
   - Visually rotates at a frame rate proportional to live RPM[cite: 3].
   - Displays magnetic field flux lines between stator poles whose opacity/density scales with Field Current ($I_f$).
   - Displays armature glow/heat tint that intensifies as $I_a^2 R_a$ heating increases.
   - Displays commutator sparks if current exceeds safe limits[cite: 3].
7. **Results and Observations Table:** Interactive Virtual Lab Observation Sheet where users can[cite: 3]:
   - Click **"Record Reading"** (or press `Spacebar`) to snapshot all current parameters into a structured table with an auto-detected Experiment Mode tag[cite: 3].
   - Click **"Auto-Sweep & Plot"** to automatically run a 8-point test sweep for the active experiment tab.
   - Compare rows (highlight min/max efficiency, speed drop, regulation) and **Export to CSV / Print Lab Report**[cite: 3].
8. **Safety Limits & Protection Relay System:** Real-time monitoring with visual warning banners, flashing LED status indicators, and an optional **"Auto-Trip Circuit Breaker"** for[cite: 3]:
   - **Excessive Armature Current ($I_a > 25\text{ A}$ warning, $I_a > 40\text{ A}$ trip):** E.g., starting at full voltage without soft-start or stalling under heavy load[cite: 3].
   - **Overspeed / Field Runaway ($N > 2200\text{ RPM}$ warning, $N > 2800\text{ RPM}$ trip):** Triggered when Field Current ($I_f$) is reduced too low while voltage is applied[cite: 3].
   - **Field Failure ($I_f < 0.15\text{ A}$ while $V_a > 30\text{ V}$):** Critical "Field Loss Runaway Hazard" alarm[cite: 3].
   - **Thermal Overload / Stall Condition ($N = 0\text{ RPM}$ while $I_a > 15\text{ A}$):** "Rotor Stalled - High $I^2R$ Heating!" warning[cite: 3].

---

## 3. Realistic Physics & Mathematical Engine (`requestAnimationFrame` Loop)
Use a realistic discrete-time differential equation solver running at 60 FPS ($\Delta t = 0.0167\text{ s}$) so the motor exhibits authentic mechanical inertia, starting current spikes, and smooth acceleration/deceleration rather than jumping instantaneously[cite: 4].

### Nameplate Rated Constants (5 HP / 3.7 kW Industrial DC Motor):
- Rated Armature Voltage ($V_{rated}$): `240 V`
- Rated Field Current ($I_{f,rated}$): `1.5 A` (Range: `0.0 A` to `2.5 A`)
- Rated Armature Current ($I_{a,rated}$): `20 A` (Max safe continuous: `25 A`, Breaker trip: `45 A`)
- Rated Base Speed ($N_{rated}$): `1500 RPM`
- Armature Resistance ($R_a$): `0.8 Ω`
- Field Resistance ($R_f$): `120 Ω` (Used to compute total input power $P_{in} = V_a I_a + V_f I_f$)
- Back-EMF / Torque Constant ($K_0$): `1.0` (Normalized so that at $I_f = 1.5\text{ A}$, $K\Phi \approx 1.42\text{ V}\cdot\text{s/rad}$)
- Rotor + Load Moment of Inertia ($J$): `0.08 kg·m²`
- Viscous Friction Coefficient ($B$): `0.008 N·m·s/rad`

### Governing Equations per Time Step ($\Delta t$):
1. **Magnetic Flux ($\Phi$) with Magnetic Saturation Curve:**
   To make the simulator genuinely impressive to Electrical Engineering professors, model subtle core saturation using a hyperbolic tangent or rational function:
   $$\Phi(I_f) = \frac{1.8 \cdot I_f}{1 + 0.4 \cdot I_f}$$
   *(At $I_f = 1.5\text{ A}$, $\Phi \approx 1.6875\text{ Wb-turns}$)*
2. **Back EMF ($E_b$):**
   $$E_b = \Phi(I_f) \cdot \omega$$
   *(where $\omega = \frac{2\pi N}{60}$ is angular velocity in $\text{rad/s}$)*
3. **Armature Current ($I_a$) with 3-Point Soft Starter Option:**
   - If the **Soft Starter / Starting Rheostat ($R_{ext}$)** toggle is ON during start-up, add temporary external resistance that steps down to $0\ \Omega$ as $\omega$ rises.
   - If power is ON:
     $$I_a = \max\left(0, \frac{V_{a,effective} - E_b}{R_a + R_{ext}}\right)$$
4. **Electromagnetic Torque ($\tau_e$):**
   $$\tau_e = \Phi(I_f) \cdot I_a$$
5. **Net Acceleration & Speed Integration:**
   $$\frac{d\omega}{dt} = \frac{\tau_e - \tau_{load} - B\omega}{J}$$
   $$\omega_{t+\Delta t} = \max\left(0, \omega_t + \frac{d\omega}{dt} \cdot \Delta t\right)$$
   $$N = \omega \cdot \frac{60}{2\pi}$$
6. **Power & Efficiency Calculations:**
   - Field Power: $P_f = I_f^2 \cdot R_f$
   - Armature Input Power: $P_a = V_a \cdot I_a$
   - Total Input Power: $P_{in} = P_a + P_f$
   - Mechanical Output Power: $P_{out} = \tau_{load} \cdot \omega$
   - Copper Losses: $P_{cu} = I_a^2 R_a + I_f^2 R_f$
   - Efficiency: $\eta = \left(\frac{P_{out}}{P_{in}}\right) \times 100\%$ (Clamp to `0%` when $P_{in} = 0$ or stalled).

---

## 4. UI/UX Architecture & Visual Aesthetic ("Dark Industrial SCADA Theme")
Design a sleek, responsive, zero-scroll (on desktop 1080p) dashboard layout with a toggleable **Lab Report Drawer/Section** below:

- **Color Palette:**
  - Background Primary: `#0B0F19` (Deep Obsidian Slate)
  - Panel Surface: `#111827` with `1px solid #1F2937` borders and subtle glassmorphism (`backdrop-filter: blur(8px)`)
  - Accent Cyan (Armature / Speed): `#06B6D4`
  - Accent Amber (Field Excitation / Flux): `#F59E0B`
  - Accent Emerald (Torque / Normal Status): `#10B981`
  - Accent Crimson (Overcurrent / Overspeed / Trip): `#EF4444`
- **Typography:**
  - Headings & UI: `'Inter'`, `'Plus Jakarta Sans'`, or system sans-serif.
  - Digital Readouts & Equations: `'JetBrains Mono'` or `'Fira Code'` (`font-variant-numeric: tabular-nums` so numbers never jitter during 60fps updates).

### Dashboard Grid Layout:
1. **Top Header Bar:**
   - Title: **SIMULAB // DC-3000 Interactive DC Motor Test Bench**
   - Main Contactor Switch (**START / STOP MOTOR**), **3-Point Starter Toggle** (Protects against starting current surge), **Auto-Breaker Toggle**, and **Emergency Stop / Reset Button**.
   - Live System Status Pill (`NORMAL OPERATION`, `HIGH STARTING CURRENT`, `FIELD WEAKENING OVER-SPEED`, `BREAKER TRIPPED`).
2. **Left Column (Control Console & Guided Experiments):**
   - **Armature Control Card:** Slider (`0V` to `300V`), fine step buttons (`-5V`, `+5V`), live voltage bar[cite: 3].
   - **Field Excitation Card:** Slider (`0.00A` to `2.50A`), warning zone highlighted below `0.3A` ("Flux Weakening / Runaway Zone")[cite: 3].
   - **Mechanical Load Dynamometer Card:** Slider (`0 Nm` to `50 Nm`), quick load preset pills (`No Load`, `Half Load`, `Rated 25Nm`, `Overload`)[cite: 3].
   - **Guided Lab Presets (1-Click Demo Scenarios for Judges):**
     - *Exp 1: Armature Voltage Speed Control*
     - *Exp 2: Field Weakening & Overspeed Runaway*
     - *Exp 3: Load Test & Speed Regulation*
     - *Exp 4: Direct-On-Line Starting Surge vs. Soft Starter*
3. **Center Column (Interactive Motor Visualizer & Circuit Schematic):**
   - **Tab 1: 2D Animated Motor & Dynamometer Cutaway (HTML5 Canvas):**
     - Shows North/South stator field coils with animated magnetic flux lines whose density scales with $I_f$.
     - Shows spinning rotor/armature with slots, commutator segments, carbon brushes (with dynamic sparking particles when $I_a > 25\text{ A}$), cooling fan blades, and digital RPM tachometer overlay[cite: 3].
   - **Tab 2: Live Interactive Equivalent Circuit Diagram (SVG):**
     - Shows the Separately Excited DC Motor circuit ($V_f$, $R_f$, $I_f$ on left; $V_a$, $R_a$, $I_a$, and rotating Back-EMF circle $E_b$ on right) with animated current-flow dots whose speed scales with live currents!
4. **Right Column (Live Telemetry Gauges & Real-Time Oscilloscope/Characteristic Graphs):**
   - **6 Digital Telemetry Readout Cards:** Speed ($N$), Armature Current ($I_a$), Field Current ($I_f$), Armature Voltage ($V_a$), Torque ($\tau$), Input Power ($P_{in}$), plus secondary pills for Back EMF ($E_b$) and Efficiency ($\eta$)[cite: 3].
   - **Multi-Mode Graphing Panel:**
     - **Mode 1: Live Time-Domain Strip Chart (Oscilloscope)** plotting $N$, $I_a$, and $\tau$ over the last 15 seconds.
     - **Mode 2: Speed vs. Armature Voltage ($N$ vs $V_a$)** with theoretical line + live operating cursor + recorded user points[cite: 3].
     - **Mode 3: Speed vs. Field Current ($N$ vs $I_f$)** showing the hyperbolic curve + overspeed danger zone[cite: 3].
     - **Mode 4: Armature Current & Speed vs. Load ($I_a, N$ vs $\tau_{load}$)**[cite: 3].
5. **Bottom Panel (Observation Table & Automated Lab Analysis)[cite: 3]:**
   - Action Bar: **`+ Record Observation (Space)`**, **`⚡ Auto-Sweep Current Curve`**, **`📥 Export CSV`**, **`🗑️ Clear Table`**.
   - Columns: `Sr. No.`, `Timestamp`, `Test Mode`, `Va (V)`, `If (A)`, `Load (Nm)`, `Speed (RPM)`, `Ia (A)`, `Eb (V)`, `Pin (W)`, `Efficiency (%)`, `Status`.
   - **Live Engineering Insights Box:** Automatically explains *why* the motor is behaving the way it is right now (e.g., *"Decreasing Field Current reduced flux $\Phi$, causing Back EMF ($E_b$) to drop momentarily. This drew a surge of Armature Current ($I_a$), accelerating the rotor above base speed."*).

---

## 5. File Structure & Technical Implementation Rules
Create a clean, modular project structure (or self-contained workspace):
- `index.html` — Semantic layout, SVG icons, Canvas containers, telemetry grid, control sliders, and observation table.
- `styles.css` — Industrial dark theme, custom range slider styling, glowing status badges, responsive grid, print stylesheet for lab reports.
- `script.js` — Complete 60FPS physics engine, HTML5 Canvas motor & circuit renderer, Chart.js / Canvas plotting engine, safety protection logic, sound synthesizer (optional Web Audio API motor hum pitch-shifted by RPM with a mute toggle!), and CSV export.

### Strict Quality Guardrails:
- **Zero Broken Dependencies:** Use either native HTML5 `<canvas>` plotting or a reliable CDN for `Chart.js` with a fallback.
- **No Unhandled NaN/Infinity:** Guard against division by zero when $I_f = 0$ (include realistic residual magnetism $\Phi_{res} = 0.04\text{ Wb}$ so $I_f = 0$ produces a dramatic runaway to $>4000\text{ RPM}$ and trips the overspeed breaker rather than crashing with `Infinity`)[cite: 3, 4].
- **Immediate Visual Polish:** Pre-populate the characteristic graphs with theoretical reference curves in a muted dashed style, and plot the live operating point as a glowing pulsing beacon on the curve.

Please generate the complete, production-ready code for `index.html`, `styles.css`, and `script.js` now.