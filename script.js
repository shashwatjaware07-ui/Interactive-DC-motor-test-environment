/**
 * ============================================================================
 * SIMULAB // DC-3000 INTERACTIVE DC MOTOR TESTING & CONTROL SIMULATOR
 * Complete Production JavaScript Engine (60 FPS ODE Physics + Visuals + SCADA)
 * ============================================================================
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. PHYSICAL CONSTANTS & MACHINE NAMEPLATE SPECIFICATIONS
  // ==========================================================================
  const MACHINE = {
    // Electrical parameters (5 HP / 3.7 kW Industrial Separately Excited DC Motor)
    Ra: 0.8,               // Armature winding resistance (Ohms)
    Rf: 120.0,             // Field winding resistance (Ohms)
    V_rated: 240.0,        // Rated armature voltage (Volts)
    If_rated: 1.50,        // Rated field current (Amperes)
    Ia_rated: 20.0,        // Rated armature current (Amperes)
    Ia_warn: 25.0,         // Overcurrent warning threshold (Amperes)
    Ia_trip: 40.0,         // Overcurrent breaker trip threshold (Amperes)
    N_rated: 1500.0,       // Rated base speed (RPM)
    N_warn: 2000.0,        // Overspeed warning threshold (RPM)
    N_trip: 2600.0,        // Overspeed breaker trip threshold (RPM)
    
    // Mechanical parameters
    J: 0.06,               // Total moment of inertia (kg*m^2)
    B: 0.006,              // Viscous friction coefficient (N*m*s/rad)
    T_rated: 25.0,         // Rated shaft load torque (Nm)
    
    // Magnetic saturation model parameters
    Phi_res: 0.05,         // Residual magnetic flux (Wb)
    Phi_k1: 1.75,          // Saturation curve scale factor
    Phi_k2: 0.35,          // Saturation curve curvature
    
    // 3-Point Starter Rheostat
    R_starter_max: 6.0     // Maximum external starting resistance (Ohms)
  };

  // ==========================================================================
  // 2. SIMULATION STATE
  // ==========================================================================
  const state = {
    // Contactor & relays
    powerOn: false,
    softStarterEnabled: true,
    autoBreakerEnabled: true,
    breakerTripped: false,
    tripReason: '',
    tripTimer: 0,

    // Controls (User inputs)
    Va_target: 240.0,      // Desired armature voltage (V)
    If_target: 1.50,       // Desired field current (A)
    T_load_target: 0.0,    // Desired mechanical load torque (Nm)

    // Applied variables (Smoothed for physics stability)
    Va: 240.0,
    If: 1.50,
    T_load: 0.0,
    R_starter: 0.0,

    // Dynamic electrical & mechanical states
    omega: 0.0,            // Rotor angular velocity (rad/s)
    rpm: 0.0,              // Speed in RPM
    flux: 1.69,            // Magnetic flux (Wb)
    Eb: 0.0,               // Back electromotive force (V)
    Ia: 0.0,               // Armature current (A)
    Te: 0.0,               // Electromagnetic torque (Nm)
    Pin: 270.0,            // Total input electrical power (W)
    Pout: 0.0,             // Mechanical shaft power (W)
    Pcu: 270.0,            // Copper losses (W)
    efficiency: 0.0,       // Efficiency (%)

    // Visual animation states
    rotorAngle: 0.0,       // Rotor position in radians
    fluxPhase: 0.0,        // Magnetic flux wave phase
    currentFlowPhaseA: 0.0,// Armature current electron flow phase
    currentFlowPhaseF: 0.0,// Field current electron flow phase
    sparkParticles: [],    // Brush commutator sparks array

    // UI & Active Tabs
    visMode: 'physical',   // 'physical' | 'schematic'
    activeGraphTab: 1,     // 1: Speed vs Va, 2: Speed vs If, 3: Load vs Ia/N, 4: Oscilloscope
    showTheoretical: true,
    activePreset: 'armature',
    isAutoSweeping: false,
    audioEnabled: true,

    // Historical data points for Graphs (Recorded readings categorized by mode)
    graphPoints: {
      tab1: [],            // Speed vs Va
      tab2: [],            // Speed vs If
      tab3: []             // Load vs Ia and Speed
    },

    // Oscilloscope strip chart rolling buffer (15 seconds at ~30 FPS downsample)
    oscilloscopeBuffer: [],
    maxOscilloscopePoints: 450,

    // Observations table dataset
    observations: []
  };

  // ==========================================================================
  // 3. AUDIO SYNTHESIS ENGINE (Web Audio API)
  // ==========================================================================
  const audio = {
    ctx: null,
    isInitialized: false,
    motorOsc1: null,
    motorOsc2: null,
    motorFilter: null,
    motorGain: null,
    alarmOsc: null,
    alarmGain: null,

    init() {
      if (this.isInitialized) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();

        // 1. Motor hum fundamental (Carrier)
        this.motorOsc1 = this.ctx.createOscillator();
        this.motorOsc1.type = 'sawtooth';
        this.motorOsc1.frequency.setValueAtTime(40, this.ctx.currentTime);

        // 2. Harmonic rotor whine
        this.motorOsc2 = this.ctx.createOscillator();
        this.motorOsc2.type = 'triangle';
        this.motorOsc2.frequency.setValueAtTime(80, this.ctx.currentTime);

        // Filter to shape electric motor timbre
        this.motorFilter = this.ctx.createBiquadFilter();
        this.motorFilter.type = 'lowpass';
        this.motorFilter.frequency.setValueAtTime(320, this.ctx.currentTime);

        // Motor master gain
        this.motorGain = this.ctx.createGain();
        this.motorGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);

        // Connect motor audio graph
        this.motorOsc1.connect(this.motorFilter);
        this.motorOsc2.connect(this.motorFilter);
        this.motorFilter.connect(this.motorGain);
        this.motorGain.connect(this.ctx.destination);

        // 3. Safety Alarm Buzzer
        this.alarmOsc = this.ctx.createOscillator();
        this.alarmOsc.type = 'square';
        this.alarmOsc.frequency.setValueAtTime(880, this.ctx.currentTime);

        this.alarmGain = this.ctx.createGain();
        this.alarmGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);

        this.alarmOsc.connect(this.alarmGain);
        this.alarmGain.connect(this.ctx.destination);

        // Start oscillators
        this.motorOsc1.start();
        this.motorOsc2.start();
        this.alarmOsc.start();

        this.isInitialized = true;
      } catch (err) {
        console.warn('Web Audio API not supported or user blocked:', err);
      }
    },

    update(rpm, ia, isAlarm) {
      if (!this.isInitialized || !state.audioEnabled || !this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      const now = this.ctx.currentTime;

      // Motor sound scaling
      if (state.powerOn && rpm > 10) {
        // Pitch scales smoothly from 30 Hz to 280 Hz
        const baseFreq = 30 + (rpm / 3000) * 220;
        this.motorOsc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
        this.motorOsc2.frequency.setTargetAtTime(baseFreq * 2.5, now, 0.05);

        // Filter opens up with higher current/speed
        const filterCutoff = 250 + (rpm / 3000) * 800 + Math.min(600, ia * 20);
        this.motorFilter.frequency.setTargetAtTime(filterCutoff, now, 0.08);

        // Gain proportional to RPM and loaded current
        const targetGain = Math.min(0.12, 0.02 + (rpm / 3000) * 0.06 + (ia / 40) * 0.04);
        this.motorGain.gain.setTargetAtTime(targetGain, now, 0.05);
      } else {
        this.motorGain.gain.setTargetAtTime(0.0001, now, 0.1);
      }

      // Alarm buzzer
      if (isAlarm) {
        // Pulsing 880Hz / 660Hz alarm sound
        const pulse = (Math.sin(now * 16) > 0) ? 0.08 : 0.0001;
        this.alarmGain.gain.setTargetAtTime(pulse, now, 0.02);
      } else {
        this.alarmGain.gain.setTargetAtTime(0.0001, now, 0.05);
      }
    },

    toggleMute() {
      state.audioEnabled = !state.audioEnabled;
      if (!state.audioEnabled && this.isInitialized) {
        const now = this.ctx.currentTime;
        this.motorGain.gain.setValueAtTime(0.0001, now);
        this.alarmGain.gain.setValueAtTime(0.0001, now);
      }
      return state.audioEnabled;
    }
  };

  // ==========================================================================
  // 4. MATHEMATICAL ENGINE & 60-FPS ODE PHYSICS SOLVER
  // ==========================================================================
  function computeFlux(If) {
    // Hyperbolic saturation equation: Phi = Phi_res + (k1 * If) / (1 + k2 * If)
    const clampedIf = Math.max(0, If);
    return MACHINE.Phi_res + (MACHINE.Phi_k1 * clampedIf) / (1 + MACHINE.Phi_k2 * clampedIf);
  }

  function stepPhysics(dt) {
    // 1. Smooth target inputs to emulate physical inductances and mechanical dials
    state.Va += (state.Va_target - state.Va) * Math.min(1, dt * 15);
    state.If += (state.If_target - state.If) * Math.min(1, dt * 15);
    state.T_load += (state.T_load_target - state.T_load) * Math.min(1, dt * 15);

    // 2. Compute Stator Magnetic Flux
    state.flux = computeFlux(state.If);

    // 3. Compute 3-Point Starter Dynamic Starting Resistance
    if (state.softStarterEnabled && state.powerOn) {
      // Resistance starts at R_starter_max (6.0 Ohms) and smoothly drops to 0 Ohm as speed approaches 1200 RPM
      const speedRatio = Math.min(1.0, state.rpm / 1200.0);
      state.R_starter = Math.max(0.0, MACHINE.R_starter_max * (1.0 - speedRatio));
    } else {
      state.R_starter = 0.0;
    }

    // 4. Armature Circuit Evaluation
    const effectiveVa = (state.powerOn && !state.breakerTripped) ? state.Va : 0.0;

    // Back Electromotive Force: Eb = Phi * omega
    state.Eb = state.flux * state.omega;

    // Clamp Eb so motor doesn't act as a regenerator into an open contactor
    if (!state.powerOn) {
      state.Eb = Math.min(state.Eb, state.omega * state.flux);
    }

    // Armature Current: Ia = max(0, (Va - Eb) / (Ra + R_starter))
    const totalArmatureResistance = MACHINE.Ra + state.R_starter;
    if (state.powerOn && !state.breakerTripped) {
      state.Ia = Math.max(0.0, (effectiveVa - state.Eb) / totalArmatureResistance);
    } else {
      state.Ia = 0.0;
    }

    // 5. Electromagnetic Torque: Te = Phi * Ia
    state.Te = state.flux * state.Ia;

    // 6. Mechanical Dynamics ODE Integration (Euler Forward):
    // J * (d_omega / dt) = Te - T_load - B * omega
    const netTorque = state.Te - state.T_load - (MACHINE.B * state.omega);
    const dOmega = (netTorque / MACHINE.J) * dt;

    state.omega = Math.max(0.0, state.omega + dOmega);
    state.rpm = (state.omega * 60.0) / (2.0 * Math.PI);

    // 7. Power & Efficiency Calculations
    const Pa = effectiveVa * state.Ia;
    const Pf = Math.pow(state.If, 2) * MACHINE.Rf;
    state.Pin = Pa + Pf;
    state.Pout = state.T_load * state.omega;
    state.Pcu = Math.pow(state.Ia, 2) * MACHINE.Ra + Pf;

    if (state.Pin > 30.0 && state.rpm > 20.0 && state.powerOn) {
      state.efficiency = Math.min(100.0, Math.max(0.0, (state.Pout / state.Pin) * 100.0));
    } else {
      state.efficiency = 0.0;
    }

    // 8. Animation Phase Increments
    state.rotorAngle = (state.rotorAngle + state.omega * dt) % (2 * Math.PI);
    state.fluxPhase = (state.fluxPhase + (state.If * 4.0 + 1.0) * dt) % 1.0;
    state.currentFlowPhaseA = (state.currentFlowPhaseA + state.Ia * 0.8 * dt) % 1.0;
    state.currentFlowPhaseF = (state.currentFlowPhaseF + state.If * 1.5 * dt) % 1.0;

    // 9. Evaluate Protection Relays & Safety Limits
    evaluateSafetyLimits(dt);

    // 10. Update Brush Spark Particles
    updateSparkParticles(dt);

    // 11. Feed Oscilloscope Strip Chart Buffer (Downsampled to ~30 FPS)
    feedOscilloscopeBuffer();
  }

  // ==========================================================================
  // 5. SAFETY & RELAY PROTECTION LOGIC
  // ==========================================================================
  const safetyState = {
    isOvercurrentWarning: false,
    isOvercurrentCritical: false,
    isOverspeedWarning: false,
    isOverspeedCritical: false,
    isFieldLossCritical: false,
    isStallCritical: false,
    activeAlertText: '',
    activeAlertTitle: ''
  };

  function evaluateSafetyLimits(dt) {
    if (!state.powerOn || state.breakerTripped) {
      safetyState.isOvercurrentWarning = false;
      safetyState.isOvercurrentCritical = false;
      safetyState.isOverspeedWarning = false;
      safetyState.isOverspeedCritical = false;
      safetyState.isFieldLossCritical = false;
      safetyState.isStallCritical = false;
      return;
    }

    // 1. Armature Overcurrent
    safetyState.isOvercurrentWarning = state.Ia > MACHINE.Ia_warn && state.Ia <= MACHINE.Ia_trip;
    safetyState.isOvercurrentCritical = state.Ia > MACHINE.Ia_trip;

    // 2. Overspeed / Flux Weakening Runaway
    safetyState.isOverspeedWarning = state.rpm > MACHINE.N_warn && state.rpm <= MACHINE.N_trip;
    safetyState.isOverspeedCritical = state.rpm > MACHINE.N_trip;

    // 3. Field Failure Hazard (Very low field current with significant armature voltage applied)
    safetyState.isFieldLossCritical = (state.If < 0.20 && state.Va > 40.0 && state.powerOn);

    // 4. Rotor Stall Condition (Rotor blocked with high continuous thermal inrush)
    safetyState.isStallCritical = (state.rpm < 15.0 && state.Ia > 18.0 && state.powerOn);

    // Breaker Auto-Trip evaluation
    const isCriticalFault = safetyState.isOvercurrentCritical || 
                            safetyState.isOverspeedCritical || 
                            safetyState.isFieldLossCritical ||
                            safetyState.isStallCritical;

    if (isCriticalFault) {
      state.tripTimer += dt;
      if (safetyState.isOvercurrentCritical) {
        safetyState.activeAlertTitle = 'CRITICAL OVERCURRENT RELAY TRIP';
        safetyState.activeAlertText = `Armature current (${state.Ia.toFixed(1)} A) exceeded rated safe breaking limit (40 A).`;
      } else if (safetyState.isOverspeedCritical) {
        safetyState.activeAlertTitle = 'CRITICAL OVERSPEED RUNAWAY TRIP';
        safetyState.activeAlertText = `Rotor speed (${Math.round(state.rpm)} RPM) exceeded maximum mechanical burst threshold (2600 RPM).`;
      } else if (safetyState.isFieldLossCritical) {
        safetyState.activeAlertTitle = 'FIELD LOSS / LOSS OF EXCITATION TRIP';
        safetyState.activeAlertText = `Field current dropped below 0.20 A with voltage applied. Dangerous flux-weakening runaway prevented.`;
      } else if (safetyState.isStallCritical) {
        safetyState.activeAlertTitle = 'THERMAL OVERLOAD / STALL CONDITION';
        safetyState.activeAlertText = `Rotor stalled under excessive load (${state.T_load.toFixed(1)} Nm). High I²R heating detected.`;
      }

      // If Auto-Breaker is armed and fault persists > 0.25s, trip contactor
      if (state.autoBreakerEnabled && state.tripTimer > 0.25) {
        tripCircuitBreaker(safetyState.activeAlertTitle, safetyState.activeAlertText);
      }
    } else {
      state.tripTimer = Math.max(0, state.tripTimer - dt);
    }
  }

  function tripCircuitBreaker(title, message) {
    state.breakerTripped = true;
    state.powerOn = false;
    state.tripReason = `${title}: ${message}`;

    // Show warning banner
    const banner = document.getElementById('safetyBanner');
    const bTitle = document.getElementById('bannerFaultTitle');
    const bDesc = document.getElementById('bannerFaultDesc');
    const resetBtn = document.getElementById('resetBreakerBtn');

    if (banner && bTitle && bDesc) {
      bTitle.textContent = title;
      bDesc.textContent = message;
      banner.classList.remove('hidden');
    }

    if (resetBtn) resetBtn.disabled = false;
    updateStatusPill('TRIPPED // BREAKER OPEN', 'danger');
  }

  function resetCircuitBreaker() {
    state.breakerTripped = false;
    state.tripTimer = 0;
    state.tripReason = '';

    const banner = document.getElementById('safetyBanner');
    const resetBtn = document.getElementById('resetBreakerBtn');
    if (banner) banner.classList.add('hidden');
    if (resetBtn) resetBtn.disabled = true;

    updateStatusPill('STANDBY // READY', 'normal');
  }

  function emergencyStop() {
    state.powerOn = false;
    state.Va_target = 0;
    state.Va = 0;
    state.T_load_target = 0;
    state.T_load = 0;

    const sliderVa = document.getElementById('sliderVa');
    if (sliderVa) sliderVa.value = 0;
    const sliderLoad = document.getElementById('sliderLoad');
    if (sliderLoad) sliderLoad.value = 0;

    tripCircuitBreaker('EMERGENCY STOP ENGAGED', 'Operator triggered manual E-Stop. Main DC contactor disconnected and inputs zeroed.');
  }

  // ==========================================================================
  // 6. BRUSH COMMUTATOR SPARK PARTICLE SYSTEM
  // ==========================================================================
  function updateSparkParticles(dt) {
    // Generate sparks if current > 25A and rotor moving
    if (state.powerOn && state.Ia > 25.0 && state.rpm > 30.0) {
      const sparkIntensity = Math.min(12, Math.floor((state.Ia - 22.0) * 0.8));
      for (let i = 0; i < sparkIntensity; i++) {
        const angle = (Math.random() > 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.4;
        const speed = 60 + Math.random() * 120 + (state.rpm / 3000) * 80;
        state.sparkParticles.push({
          x: 0,
          y: 0,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.15 + Math.random() * 0.2,
          maxLife: 0.35,
          size: 1.5 + Math.random() * 2.5
        });
      }
    }

    // Update existing particles
    for (let i = state.sparkParticles.length - 1; i >= 0; i--) {
      const p = state.sparkParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        state.sparkParticles.splice(i, 1);
      }
    }
  }

  // ==========================================================================
  // 7. OSCILLOSCOPE TIME-DOMAIN BUFFER
  // ==========================================================================
  let oscDownsampleCount = 0;
  function feedOscilloscopeBuffer() {
    oscDownsampleCount++;
    if (oscDownsampleCount % 2 !== 0) return; // 30 FPS downsample

    state.oscilloscopeBuffer.push({
      time: performance.now() / 1000.0,
      rpm: state.rpm,
      Ia: state.Ia,
      Te: state.Te
    });

    if (state.oscilloscopeBuffer.length > state.maxOscilloscopePoints) {
      state.oscilloscopeBuffer.shift();
    }
  }

  // ==========================================================================
  // 8. MOTOR VISUALIZER RENDERER (Canvas View A & View B)
  // ==========================================================================
  const visCanvas = document.getElementById('motorCanvas');
  const visCtx = visCanvas ? visCanvas.getContext('2d') : null;

  function renderVisualizer() {
    if (!visCtx || !visCanvas) return;

    // Handle high DPI scaling
    const dpr = window.devicePixelRatio || 1;
    const rect = visCanvas.getBoundingClientRect();
    const w = rect.width || 760;
    const h = rect.height || 480;

    if (visCanvas.width !== w * dpr || visCanvas.height !== h * dpr) {
      visCanvas.width = w * dpr;
      visCanvas.height = h * dpr;
    }

    visCtx.save();
    visCtx.scale(dpr, dpr);

    // Clear background with dark slate radial gradient
    const bgGrad = visCtx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, Math.max(w, h));
    bgGrad.addColorStop(0, '#0c1220');
    bgGrad.addColorStop(1, '#060911');
    visCtx.fillStyle = bgGrad;
    visCtx.fillRect(0, 0, w, h);

    if (state.visMode === 'physical') {
      renderPhysicalCutaway(visCtx, w, h);
    } else {
      renderEquivalentSchematic(visCtx, w, h);
    }

    visCtx.restore();
  }

  /**
   * VIEW A: Physical Cross-Section & Dynamometer Cutaway
   */
  function renderPhysicalCutaway(ctx, w, h) {
    const cx = w * 0.42;
    const cy = h * 0.52;
    const statorR = Math.min(w, h) * 0.36;
    const rotorR = statorR * 0.58;

    // 1. Draw Stator Steel Frame & Yoke Ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, statorR + 24, 0, Math.PI * 2);
    ctx.fillStyle = '#111827';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#1f2937';
    ctx.stroke();

    // Motor Stator Base / Feet
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(cx - statorR - 20, cy + statorR + 10, (statorR + 20) * 2, 16);
    ctx.strokeStyle = '#374151';
    ctx.strokeRect(cx - statorR - 20, cy + statorR + 10, (statorR + 20) * 2, 16);

    // Inner Stator Yoke Cavity
    ctx.beginPath();
    ctx.arc(cx, cy, statorR, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0e1a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#374151';
    ctx.stroke();
    ctx.restore();

    // 2. Animated Stator Field Coils & Magnetic Flux Lines
    renderStatorPolesAndFlux(ctx, cx, cy, statorR, rotorR);

    // 3. Rotor / Armature Core with Thermal Glow
    renderRotorArmature(ctx, cx, cy, rotorR);

    // 4. Commutator, Brushes & Dynamic Sparks
    renderCommutatorAndBrushes(ctx, cx, cy, rotorR);

    // 5. Coupled Mechanical Dynamometer (Right Side)
    renderDynamometerUnit(ctx, w * 0.82, cy, Math.min(w, h) * 0.28);
  }

  function renderStatorPolesAndFlux(ctx, cx, cy, statorR, rotorR) {
    ctx.save();

    // North Pole (Left)
    const poleW = 46;
    const poleH = statorR * 0.65;
    
    // North Pole Shoe
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.roundRect(cx - statorR, cy - poleH / 2, poleW, poleH, [4, 16, 16, 4]);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // North Field Coil Windings (Cyan tint)
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(cx - statorR + 6, cy - poleH / 2 + 10, 22, poleH - 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText('N', cx - statorR + poleW - 16, cy + 4);

    // South Pole (Right)
    // South Pole Shoe
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.roundRect(cx + statorR - poleW, cy - poleH / 2, poleW, poleH, [16, 4, 4, 16]);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // South Field Coil Windings (Amber tint)
    ctx.fillStyle = '#d97706';
    ctx.fillRect(cx + statorR - poleW + 18, cy - poleH / 2 + 10, 22, poleH - 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText('S', cx + statorR - poleW + 6, cy + 4);

    // Magnetic Flux Lines (B-field) flowing from N to S
    const fluxAlpha = Math.min(0.9, Math.max(0.15, (state.If / 2.5) * 0.85));
    const fluxLinesCount = Math.floor(4 + (state.If / 2.5) * 8);

    ctx.lineWidth = 1.5;
    for (let i = 0; i < fluxLinesCount; i++) {
      const spread = ((i / (fluxLinesCount - 1)) - 0.5) * (poleH * 0.7);
      ctx.strokeStyle = `rgba(56, 189, 248, ${fluxAlpha * 0.4})`;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -state.fluxPhase * 24;

      ctx.beginPath();
      ctx.moveTo(cx - statorR + poleW, cy + spread);
      ctx.bezierCurveTo(
        cx - rotorR * 0.5, cy + spread * 0.4,
        cx + rotorR * 0.5, cy + spread * 0.4,
        cx + statorR - poleW, cy + spread
      );
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function renderRotorArmature(ctx, cx, cy, rotorR) {
    ctx.save();

    // Armature Thermal Glow Aura (Intensity tied to Ia^2 * Ra)
    const heatIntensity = Math.min(1.0, (Math.pow(state.Ia, 2) * MACHINE.Ra) / 1200.0);
    if (heatIntensity > 0.05) {
      const glowGrad = ctx.createRadialGradient(cx, cy, rotorR * 0.6, cx, cy, rotorR * 1.35);
      glowGrad.addColorStop(0, `rgba(239, 68, 68, ${heatIntensity * 0.5})`);
      glowGrad.addColorStop(0.6, `rgba(245, 158, 11, ${heatIntensity * 0.3})`);
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, rotorR * 1.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rotor Core Body (Spinning at state.rotorAngle)
    ctx.translate(cx, cy);
    ctx.rotate(state.rotorAngle);

    // Armature Laminated Core
    ctx.beginPath();
    ctx.arc(0, 0, rotorR, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = heatIntensity > 0.4 ? '#f87171' : '#475569';
    ctx.stroke();

    // Rotor Slots and Embedded Copper Conductors (12 Slots)
    const slots = 12;
    for (let i = 0; i < slots; i++) {
      const angle = (i * 2 * Math.PI) / slots;
      const x = Math.cos(angle) * (rotorR * 0.82);
      const y = Math.sin(angle) * (rotorR * 0.82);

      // Slot tooth
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = heatIntensity > 0.4 ? '#fca5a5' : '#b45309'; // Copper wire color
      ctx.fill();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Cooling Fan Blades
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#64748b';
    for (let i = 0; i < 6; i++) {
      const fanAngle = (i * 2 * Math.PI) / 6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(fanAngle) * 14, Math.sin(fanAngle) * 14);
      ctx.lineTo(Math.cos(fanAngle + 0.35) * (rotorR * 0.55), Math.sin(fanAngle + 0.35) * (rotorR * 0.55));
      ctx.stroke();
    }

    ctx.restore();
  }

  function renderCommutatorAndBrushes(ctx, cx, cy, rotorR) {
    const commR = rotorR * 0.38;

    ctx.save();
    ctx.translate(cx, cy);

    // Commutator Segments (Rotates with rotor)
    ctx.save();
    ctx.rotate(state.rotorAngle);
    ctx.beginPath();
    ctx.arc(0, 0, commR, 0, Math.PI * 2);
    ctx.fillStyle = '#b45309'; // Copper cylinder
    ctx.fill();
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Mica segment dividers
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 12; i++) {
      const a = (i * 2 * Math.PI) / 12;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * commR, Math.sin(a) * commR);
      ctx.stroke();
    }

    // Shaft Center Bore
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
    ctx.restore();

    // Carbon Brushes (Stationary, pressed at Top & Bottom)
    const brushW = 14;
    const brushH = 20;

    // Positive Brush (Top)
    ctx.fillStyle = '#111827';
    ctx.fillRect(-brushW / 2, -commR - brushH, brushW, brushH);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-brushW / 2, -commR - brushH, brushW, brushH);

    // Brush terminal lead (+)
    ctx.strokeStyle = '#06b6d4';
    ctx.beginPath();
    ctx.moveTo(0, -commR - brushH);
    ctx.lineTo(0, -commR - brushH - 12);
    ctx.stroke();

    // Negative Brush (Bottom)
    ctx.fillStyle = '#111827';
    ctx.fillRect(-brushW / 2, commR, brushW, brushH);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-brushW / 2, commR, brushW, brushH);

    // Brush terminal lead (-)
    ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(0, commR + brushH);
    ctx.lineTo(0, commR + brushH + 12);
    ctx.stroke();

    // Render Dynamic Commutator Sparks (Spraying from brush tips)
    if (state.sparkParticles.length > 0) {
      for (const p of state.sparkParticles) {
        ctx.fillStyle = '#fef08a';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y + (p.vy > 0 ? commR : -commR), p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  function renderDynamometerUnit(ctx, cx, cy, r) {
    ctx.save();

    // Mechanical Coupling Shaft linking Motor to Dynamometer
    ctx.fillStyle = '#475569';
    ctx.fillRect(cx - r * 1.2, cy - 8, r * 1.2, 16);
    ctx.strokeStyle = '#64748b';
    ctx.strokeRect(cx - r * 1.2, cy - 8, r * 1.2, 16);

    // Dynamometer Stator Casing
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#111827';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#10b981';
    ctx.stroke();

    // Internal Eddy-Current / Brake Drum
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.65, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.stroke();

    // Dynamometer Torque Reaction Pointer Arm (Deflects with T_load)
    const maxDeflection = Math.PI * 0.35;
    const deflection = (state.T_load / 50.0) * maxDeflection;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(deflection);

    // Torque pointer needle
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -r * 0.85);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#10b981';
    ctx.fill();
    ctx.restore();

    // Scale dial markings
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i / 5) * maxDeflection;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r * 0.8), cy + Math.sin(a) * (r * 0.8));
      ctx.lineTo(cx + Math.cos(a) * (r * 0.95), cy + Math.sin(a) * (r * 0.95));
      ctx.stroke();
    }

    // Dynamometer Title Badge
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DYNAMOMETER', cx, cy + r + 20);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${state.T_load.toFixed(1)} Nm`, cx, cy + r + 34);

    ctx.restore();
  }

  /**
   * VIEW B: Interactive Live Equivalent Circuit Schematic
   */
  function renderEquivalentSchematic(ctx, w, h) {
    ctx.save();

    // Title Tag
    ctx.fillStyle = '#06b6d4';
    ctx.font = 'bold 12px "Inter", sans-serif';
    ctx.fillText('SEPARATELY EXCITED DC MOTOR EQUIVALENT SCHEMATIC', 28, 28);

    // ==========================================
    // 1. LEFT BRANCH: FIELD CIRCUIT (Vf, Rf, Lf)
    // ==========================================
    const fx = w * 0.18;
    const fyTop = h * 0.22;
    const fyBot = h * 0.78;
    const fw = w * 0.20;

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f59e0b';

    // Outer Field Loop Track
    ctx.beginPath();
    ctx.moveTo(fx, fyTop);
    ctx.lineTo(fx + fw, fyTop);
    ctx.lineTo(fx + fw, fyBot);
    ctx.lineTo(fx, fyBot);
    ctx.closePath();
    ctx.stroke();

    // DC Field Supply Symbol (Vf) on left wire
    renderDcSourceSymbol(ctx, fx, (fyTop + fyBot) / 2, `Vf = ${(state.If * MACHINE.Rf).toFixed(0)} V`, '#f59e0b');

    // Field Rheostat Rf on top wire
    renderResistorSymbol(ctx, fx + fw * 0.5, fyTop, 'Rf (Rheostat)', true, '#f59e0b');

    // Field Winding Inductance Lf on right wire
    renderInductorSymbol(ctx, fx + fw, (fyTop + fyBot) / 2, 'Field Coil (Lf)', '#f59e0b');

    // Animated Field Current Flow Dots (Amber)
    if (state.If > 0.05) {
      renderFlowingDots(ctx, [
        { x: fx, y: fyBot },
        { x: fx, y: fyTop },
        { x: fx + fw, y: fyTop },
        { x: fx + fw, y: fyBot },
        { x: fx, y: fyBot }
      ], state.currentFlowPhaseF, '#f59e0b', Math.min(8, Math.max(3, state.If * 3)));
    }

    // Callout: If Field Current
    ctx.fillStyle = '#fef3c7';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText(`If = ${state.If.toFixed(2)} A`, fx + fw * 0.5 - 28, fyBot - 12);

    // ==========================================
    // 2. RIGHT BRANCH: ARMATURE CIRCUIT (Va, Starter, Ra, Eb)
    // ==========================================
    const ax = w * 0.52;
    const ayTop = h * 0.22;
    const ayBot = h * 0.78;
    const aw = w * 0.38;

    ctx.strokeStyle = '#06b6d4';

    // Armature Loop Track
    ctx.beginPath();
    ctx.moveTo(ax, ayTop);
    ctx.lineTo(ax + aw, ayTop);
    ctx.lineTo(ax + aw, ayBot);
    ctx.lineTo(ax, ayBot);
    ctx.closePath();
    ctx.stroke();

    // Main DC Contactor Switch on top wire
    renderContactorSwitch(ctx, ax + 35, ayTop, state.powerOn && !state.breakerTripped);

    // 3-Point Starter Resistor on top wire
    renderStarterRheostatSymbol(ctx, ax + aw * 0.42, ayTop, state.R_starter);

    // Armature Resistance Ra on top wire
    renderResistorSymbol(ctx, ax + aw * 0.78, ayTop, `Ra = ${MACHINE.Ra} Ω`, false, '#06b6d4');

    // Main DC Armature Supply Symbol (Va) on left wire
    renderDcSourceSymbol(ctx, ax, (ayTop + ayBot) / 2, `Va = ${state.Va.toFixed(1)} V`, '#06b6d4');

    // Rotating Armature Back EMF Symbol (Eb) on right wire
    renderArmatureMotorSymbol(ctx, ax + aw, (ayTop + ayBot) / 2, state.Eb, state.rpm);

    // Animated Armature Current Flow Dots (Cyan/Emerald)
    if (state.powerOn && !state.breakerTripped && state.Ia > 0.1) {
      renderFlowingDots(ctx, [
        { x: ax, y: ayBot },
        { x: ax, y: ayTop },
        { x: ax + aw, y: ayTop },
        { x: ax + aw, y: ayBot },
        { x: ax, y: ayBot }
      ], state.currentFlowPhaseA, '#38bdf8', Math.min(10, Math.max(3, state.Ia * 0.4)));
    }

    // Callout: Ia Armature Current
    ctx.fillStyle = '#e0f2fe';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText(`Ia = ${state.Ia.toFixed(2)} A`, ax + aw * 0.5 - 28, ayBot - 12);

    ctx.restore();
  }

  function renderDcSourceSymbol(ctx, x, y, label, color) {
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(x - 20, y - 24, 40, 48);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;

    // Positive plate (longer)
    ctx.beginPath();
    ctx.moveTo(x - 14, y - 8);
    ctx.lineTo(x + 14, y - 8);
    ctx.stroke();

    // Negative plate (shorter)
    ctx.beginPath();
    ctx.moveTo(x - 8, y + 8);
    ctx.lineTo(x + 8, y + 8);
    ctx.stroke();

    // Polarity labels
    ctx.fillStyle = color;
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.fillText('+', x + 18, y - 6);
    ctx.fillText('-', x + 18, y + 10);

    // Text Label
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillText(label, x - 32, y + 34);

    ctx.restore();
  }

  function renderResistorSymbol(ctx, x, y, label, isVariable, color) {
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(x - 24, y - 12, 48, 24);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    // Zigzag resistor lines
    ctx.beginPath();
    ctx.moveTo(x - 20, y);
    ctx.lineTo(x - 14, y - 8);
    ctx.lineTo(x - 6, y + 8);
    ctx.lineTo(x + 2, y - 8);
    ctx.lineTo(x + 10, y + 8);
    ctx.lineTo(x + 16, y - 8);
    ctx.lineTo(x + 20, y);
    ctx.stroke();

    // Arrow for variable rheostat
    if (isVariable) {
      ctx.strokeStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(x - 16, y + 14);
      ctx.lineTo(x + 16, y - 14);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 10, y - 14);
      ctx.lineTo(x + 16, y - 14);
      ctx.lineTo(x + 16, y - 8);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - 16);

    ctx.restore();
  }

  function renderInductorSymbol(ctx, x, y, label, color) {
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(x - 12, y - 26, 24, 52);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    // Multi-loop inductor
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x, y - 16 + i * 16, 8, -Math.PI / 2, Math.PI / 2, false);
      ctx.stroke();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 36);
    ctx.restore();
  }

  function renderContactorSwitch(ctx, x, y, isClosed) {
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(x - 15, y - 10, 30, 20);

    // Switch terminals
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(x - 12, y, 3, 0, Math.PI * 2);
    ctx.arc(x + 12, y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Switch knife blade
    ctx.strokeStyle = isClosed ? '#10b981' : '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    if (isClosed) {
      ctx.lineTo(x + 12, y);
    } else {
      ctx.lineTo(x + 8, y - 16);
    }
    ctx.stroke();

    ctx.fillStyle = isClosed ? '#10b981' : '#ef4444';
    ctx.font = 'bold 9px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isClosed ? 'CLOSED' : 'OPEN', x, y - 18);
    ctx.restore();
  }

  function renderStarterRheostatSymbol(ctx, x, y, rExt) {
    ctx.save();
    renderResistorSymbol(ctx, x, y, `R_starter = ${rExt.toFixed(1)} Ω`, true, '#06b6d4');
    ctx.restore();
  }

  function renderArmatureMotorSymbol(ctx, x, y, eb, rpm) {
    const r = 26;
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.fillRect(x - 32, y - 32, 64, 64);

    // Motor Circle Symbol (M)
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Internal "M" and Eb symbol
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 15px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('M', x, y - 2);

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(`Eb`, x, y + 12);

    // Rotating arrow indicating motor rotation
    if (rpm > 10) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(state.rotorAngle);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r + 6, 0, Math.PI * 0.7);
      ctx.stroke();
      ctx.restore();
    }

    // Callout values
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillText(`Eb = ${eb.toFixed(1)} V`, x, y + r + 18);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${Math.round(rpm)} RPM`, x, y + r + 30);

    ctx.restore();
  }

  function renderFlowingDots(ctx, points, phase, color, numDots) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;

    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const len = Math.hypot(dx, dy);
      segLens.push(len);
      totalLen += len;
    }

    for (let d = 0; d < numDots; d++) {
      const dotFrac = (phase + (d / numDots)) % 1.0;
      let targetDist = dotFrac * totalLen;

      let ptX = points[0].x;
      let ptY = points[0].y;

      for (let i = 0; i < segLens.length; i++) {
        if (targetDist <= segLens[i]) {
          const t = targetDist / segLens[i];
          ptX = points[i].x + (points[i + 1].x - points[i].x) * t;
          ptY = points[i].y + (points[i + 1].y - points[i].y) * t;
          break;
        }
        targetDist -= segLens[i];
      }

      ctx.beginPath();
      ctx.arc(ptX, ptY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // ==========================================================================
  // 9. MULTI-TABBED INTERACTIVE GRAPH PLOTTER (CANVAS)
  // ==========================================================================
  const graphCanvas = document.getElementById('graphCanvas');
  const graphCtx = graphCanvas ? graphCanvas.getContext('2d') : null;

  function renderGraph() {
    if (!graphCtx || !graphCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = graphCanvas.getBoundingClientRect();
    const w = rect.width || 760;
    const h = rect.height || 300;

    if (graphCanvas.width !== w * dpr || graphCanvas.height !== h * dpr) {
      graphCanvas.width = w * dpr;
      graphCanvas.height = h * dpr;
    }

    graphCtx.save();
    graphCtx.scale(dpr, dpr);

    // Background
    graphCtx.fillStyle = '#080c14';
    graphCtx.fillRect(0, 0, w, h);

    const pad = { top: 24, right: 30, bottom: 36, left: 54 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    switch (state.activeGraphTab) {
      case 1:
        renderGraphTab1(graphCtx, pad, plotW, plotH);
        break;
      case 2:
        renderGraphTab2(graphCtx, pad, plotW, plotH);
        break;
      case 3:
        renderGraphTab3(graphCtx, pad, plotW, plotH);
        break;
      case 4:
        renderGraphTab4(graphCtx, pad, plotW, plotH);
        break;
    }

    graphCtx.restore();
  }

  /**
   * TAB 1: Speed (RPM) vs. Armature Voltage (Va)
   */
  function renderGraphTab1(ctx, pad, plotW, plotH) {
    const maxX = 300;  // Volts
    const maxY = 3000; // RPM

    drawGrid(ctx, pad, plotW, plotH, 6, 6, maxX, maxY, 'Armature Voltage Va (V)', 'Speed N (RPM)');

    // 1. Theoretical Characteristic Curve (Dashed line: N = (60 / 2pi) * (Va - Ia_rated * Ra) / Phi)
    if (state.showTheoretical) {
      const fixedFlux = computeFlux(state.If);
      ctx.save();
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();

      for (let va = 0; va <= maxX; va += 10) {
        const theoreticalEb = Math.max(0, va - (MACHINE.Ia_rated * MACHINE.Ra));
        const theoreticalOmega = theoreticalEb / fixedFlux;
        const theoreticalRpm = (theoreticalOmega * 60) / (2 * Math.PI);

        const px = pad.left + (va / maxX) * plotW;
        const py = pad.top + plotH - (Math.min(maxY, theoreticalRpm) / maxY) * plotH;

        if (va === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. User Recorded Data Points (Tab 1)
    for (const pt of state.graphPoints.tab1) {
      const px = pad.left + (pt.va / maxX) * plotW;
      const py = pad.top + plotH - (Math.min(maxY, pt.rpm) / maxY) * plotH;
      drawRecordedPoint(ctx, px, py, '#06b6d4', `${pt.va}V, ${Math.round(pt.rpm)}RPM`);
    }

    // 3. Live Operating Point Cursor (Pulsing beacon)
    const curX = pad.left + (state.Va / maxX) * plotW;
    const curY = pad.top + plotH - (Math.min(maxY, state.rpm) / maxY) * plotH;
    drawLiveCursor(ctx, curX, curY, '#06b6d4', `${state.Va.toFixed(0)} V, ${Math.round(state.rpm)} RPM`);
  }

  /**
   * TAB 2: Speed (RPM) vs. Field Current (If) [Hyperbolic Flux-Weakening]
   */
  function renderGraphTab2(ctx, pad, plotW, plotH) {
    const maxX = 2.5;  // Amperes
    const maxY = 3500; // RPM

    // Shading Runaway Danger Zone (If < 0.30 A)
    const dangerX = pad.left + (0.30 / maxX) * plotW;
    ctx.save();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
    ctx.fillRect(pad.left, pad.top, dangerX - pad.left, plotH);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dangerX, pad.top);
    ctx.lineTo(dangerX, pad.top + plotH);
    ctx.stroke();

    ctx.fillStyle = '#f87171';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText('RUNAWAY HAZARD', pad.left + 6, pad.top + 16);
    ctx.restore();

    drawGrid(ctx, pad, plotW, plotH, 5, 7, maxX, maxY, 'Field Current If (A)', 'Speed N (RPM)');

    // 1. Theoretical Hyperbolic Curve: N proportional to 1 / Phi(If)
    if (state.showTheoretical) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();

      for (let ifVal = 0.15; ifVal <= maxX; ifVal += 0.05) {
        const phi = computeFlux(ifVal);
        const theoreticalEb = Math.max(0, state.Va - (MACHINE.Ia_rated * MACHINE.Ra));
        const theoreticalOmega = theoreticalEb / phi;
        const theoreticalRpm = (theoreticalOmega * 60) / (2 * Math.PI);

        const px = pad.left + (ifVal / maxX) * plotW;
        const py = pad.top + plotH - (Math.min(maxY, theoreticalRpm) / maxY) * plotH;

        if (ifVal === 0.15) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. User Recorded Data Points (Tab 2)
    for (const pt of state.graphPoints.tab2) {
      const px = pad.left + (pt.ifVal / maxX) * plotW;
      const py = pad.top + plotH - (Math.min(maxY, pt.rpm) / maxY) * plotH;
      drawRecordedPoint(ctx, px, py, '#f59e0b', `${pt.ifVal.toFixed(2)}A, ${Math.round(pt.rpm)}RPM`);
    }

    // 3. Live Operating Point Cursor
    const curX = pad.left + (state.If / maxX) * plotW;
    const curY = pad.top + plotH - (Math.min(maxY, state.rpm) / maxY) * plotH;
    drawLiveCursor(ctx, curX, curY, '#f59e0b', `${state.If.toFixed(2)} A, ${Math.round(state.rpm)} RPM`);
  }

  /**
   * TAB 3: Load vs. Ia & Speed (T_load vs. Ia & N)
   */
  function renderGraphTab3(ctx, pad, plotW, plotH) {
    const maxX = 50.0; // Nm Load
    const maxY_rpm = 2500;
    const maxY_ia = 50.0;

    drawGrid(ctx, pad, plotW, plotH, 5, 5, maxX, maxY_rpm, 'Mechanical Load Torque (Nm)', 'Speed N (RPM)');

    // 1. Theoretical Curves (Speed droop cyan, Current rise emerald)
    if (state.showTheoretical) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);

      // Speed Droop
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
      ctx.beginPath();
      for (let t = 0; t <= maxX; t += 2) {
        const phi = computeFlux(state.If);
        const iaReq = t / phi;
        const theoreticalEb = Math.max(0, state.Va - iaReq * MACHINE.Ra);
        const theoreticalRpm = (theoreticalEb / phi) * 60 / (2 * Math.PI);
        const px = pad.left + (t / maxX) * plotW;
        const py = pad.top + plotH - (Math.min(maxY_rpm, theoreticalRpm) / maxY_rpm) * plotH;
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Current Rise
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
      ctx.beginPath();
      for (let t = 0; t <= maxX; t += 2) {
        const phi = computeFlux(state.If);
        const iaReq = t / phi;
        const px = pad.left + (t / maxX) * plotW;
        const py = pad.top + plotH - (Math.min(maxY_ia, iaReq) / maxY_ia) * plotH;
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. User Recorded Data Points (Tab 3)
    for (const pt of state.graphPoints.tab3) {
      const px = pad.left + (pt.load / maxX) * plotW;
      const pyRpm = pad.top + plotH - (Math.min(maxY_rpm, pt.rpm) / maxY_rpm) * plotH;
      const pyIa = pad.top + plotH - (Math.min(maxY_ia, pt.ia) / maxY_ia) * plotH;
      drawRecordedPoint(ctx, px, pyRpm, '#06b6d4', `${pt.load}Nm: ${Math.round(pt.rpm)} RPM`);
      drawRecordedPoint(ctx, px, pyIa, '#10b981', `${pt.load}Nm: ${pt.ia.toFixed(1)} A`);
    }

    // 3. Live Operating Point Cursors
    const curX = pad.left + (state.T_load / maxX) * plotW;
    const curYRpm = pad.top + plotH - (Math.min(maxY_rpm, state.rpm) / maxY_rpm) * plotH;
    const curYIa = pad.top + plotH - (Math.min(maxY_ia, state.Ia) / maxY_ia) * plotH;
    drawLiveCursor(ctx, curX, curYRpm, '#06b6d4', `N: ${Math.round(state.rpm)}`);
    drawLiveCursor(ctx, curX, curYIa, '#10b981', `Ia: ${state.Ia.toFixed(1)}A`);
  }

  /**
   * TAB 4: Live Time-Domain Oscilloscope Strip Chart (Speed, Ia, Torque)
   */
  function renderGraphTab4(ctx, pad, plotW, plotH) {
    const buf = state.oscilloscopeBuffer;
    drawGrid(ctx, pad, plotW, plotH, 6, 5, '15s', '100%', 'Time Window (Rolling 15 Seconds)', 'Normalized SCADA Traces');

    if (buf.length < 2) return;

    // Normalization scales:
    // Speed: 0 to 3000 RPM (Cyan)
    // Armature Current: 0 to 50 A (Emerald)
    // Torque: 0 to 50 Nm (Amber)

    // Trace 1: Speed (Cyan)
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#06b6d4';
    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const px = pad.left + (i / (state.maxOscilloscopePoints - 1)) * plotW;
      const normVal = Math.min(1.0, Math.max(0, buf[i].rpm / 3000.0));
      const py = pad.top + plotH - (normVal * plotH);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Trace 2: Armature Current Ia (Emerald)
    ctx.strokeStyle = '#10b981';
    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const px = pad.left + (i / (state.maxOscilloscopePoints - 1)) * plotW;
      const normVal = Math.min(1.0, Math.max(0, buf[i].Ia / 50.0));
      const py = pad.top + plotH - (normVal * plotH);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Trace 3: Torque (Amber)
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const px = pad.left + (i / (state.maxOscilloscopePoints - 1)) * plotW;
      const normVal = Math.min(1.0, Math.max(0, buf[i].Te / 50.0));
      const py = pad.top + plotH - (normVal * plotH);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawGrid(ctx, pad, plotW, plotH, xDivs, yDivs, maxXLabel, maxYLabel, xTitle, yTitle) {
    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;

    // Vertical grid lines
    for (let i = 0; i <= xDivs; i++) {
      const x = pad.left + (i / xDivs) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();

      // X Tick Labels
      if (typeof maxXLabel === 'number') {
        const val = ((i / xDivs) * maxXLabel);
        ctx.fillStyle = '#64748b';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(Number.isInteger(val) ? val.toString() : val.toFixed(1), x, pad.top + plotH + 16);
      }
    }

    // Horizontal grid lines
    for (let i = 0; i <= yDivs; i++) {
      const y = pad.top + (i / yDivs) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      // Y Tick Labels
      if (typeof maxYLabel === 'number') {
        const val = Math.round(((yDivs - i) / yDivs) * maxYLabel);
        ctx.fillStyle = '#64748b';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(val.toString(), pad.left - 8, y + 3);
      }
    }

    // Axis Border
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    // Axis Titles
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xTitle, pad.left + plotW / 2, pad.top + plotH + 30);

    ctx.save();
    ctx.translate(pad.left - 38, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yTitle, 0, 0);
    ctx.restore();

    ctx.restore();
  }

  function drawRecordedPoint(ctx, x, y, color, label) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }

  function drawLiveCursor(ctx, x, y, color, label) {
    ctx.save();
    // Crosshair Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 600);
    ctx.moveTo(0, y);
    ctx.lineTo(1000, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pulsing outer halo
    const pulse = 6 + Math.sin(performance.now() * 0.01) * 3;
    ctx.beginPath();
    ctx.arc(x, y, pulse, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Solid core
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Floating Coordinate Tag
    ctx.fillStyle = 'rgba(11, 15, 25, 0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 8, y - 22, label.length * 7 + 12, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 14, y - 9);

    ctx.restore();
  }

  // ==========================================================================
  // 10. REAL-TIME DOM TELEMETRY SYNC
  // ==========================================================================
  const dom = {
    // Sliders & inputs
    sliderVa: document.getElementById('sliderVa'),
    valVaDisplay: document.getElementById('valVaDisplay'),
    sliderIf: document.getElementById('sliderIf'),
    valIfDisplay: document.getElementById('valIfDisplay'),
    sliderLoad: document.getElementById('sliderLoad'),
    valLoadDisplay: document.getElementById('valLoadDisplay'),

    // Digital SCADA Readouts
    readoutSpeed: document.getElementById('readoutSpeed'),
    progSpeed: document.getElementById('progSpeed'),
    readoutIa: document.getElementById('readoutIa'),
    progIa: document.getElementById('progIa'),
    readoutIf: document.getElementById('readoutIf'),
    progIf: document.getElementById('progIf'),
    readoutVa: document.getElementById('readoutVa'),
    progVa: document.getElementById('progVa'),
    readoutTe: document.getElementById('readoutTe'),
    progTe: document.getElementById('progTe'),
    readoutPin: document.getElementById('readoutPin'),
    progPin: document.getElementById('progPin'),

    // Secondary Telemetry
    readoutEb: document.getElementById('readoutEb'),
    readoutPcu: document.getElementById('readoutPcu'),
    readoutPout: document.getElementById('readoutPout'),
    readoutEff: document.getElementById('readoutEff'),

    // Sub-gauges & Canvas HUD
    hudOmega: document.getElementById('hudOmega'),
    hudFlux: document.getElementById('hudFlux'),
    hudSparks: document.getElementById('hudSparks'),
    fluxFillBar: document.getElementById('fluxFillBar'),
    fluxPercentVal: document.getElementById('fluxPercentVal'),
    thermalFillBar: document.getElementById('thermalFillBar'),
    thermalPercentVal: document.getElementById('thermalPercentVal'),
    rheoFillBar: document.getElementById('rheoFillBar'),
    rheoVal: document.getElementById('rheoVal'),
    visFpsDisplay: document.getElementById('visFpsDisplay'),

    // Header buttons & indicators
    powerSwitch: document.getElementById('powerSwitch'),
    powerLed: document.getElementById('powerLed'),
    powerBtnText: document.getElementById('powerBtnText'),
    starterToggle: document.getElementById('starterToggle'),
    starterLed: document.getElementById('starterLed'),
    starterBtnText: document.getElementById('starterBtnText'),
    breakerToggle: document.getElementById('breakerToggle'),
    breakerLed: document.getElementById('breakerLed'),
    breakerBtnText: document.getElementById('breakerBtnText'),
    audioToggle: document.getElementById('audioToggle'),
    audioStatusText: document.getElementById('audioStatusText'),
    systemBeacon: document.getElementById('systemBeacon'),
    mainStatusPill: document.getElementById('mainStatusPill'),
    pillStatusText: document.getElementById('pillStatusText'),
    clockDisplay: document.getElementById('clockDisplay'),

    // Table & Insights
    insightText: document.getElementById('insightText'),
    obsCountBadge: document.getElementById('obsCountBadge'),
    observationTableBody: document.getElementById('observationTableBody'),
    emptyTableMessage: document.getElementById('emptyTableMessage'),
    anaPeakEff: document.getElementById('anaPeakEff'),
    anaRegulation: document.getElementById('anaRegulation'),
    anaSweepStatus: document.getElementById('anaSweepStatus')
  };

  function updateDomTelemetry(fps) {
    // 1. Digital Readout Cards (Tabular Numeric values)
    if (dom.readoutSpeed) dom.readoutSpeed.textContent = Math.round(state.rpm);
    if (dom.progSpeed) dom.progSpeed.style.width = `${Math.min(100, (state.rpm / 3000) * 100)}%`;

    if (dom.readoutIa) dom.readoutIa.textContent = state.Ia.toFixed(2);
    if (dom.progIa) dom.progIa.style.width = `${Math.min(100, (state.Ia / 50) * 100)}%`;

    if (dom.readoutIf) dom.readoutIf.textContent = state.If.toFixed(2);
    if (dom.progIf) dom.progIf.style.width = `${Math.min(100, (state.If / 2.5) * 100)}%`;

    if (dom.readoutVa) dom.readoutVa.textContent = state.Va.toFixed(1);
    if (dom.progVa) dom.progVa.style.width = `${Math.min(100, (state.Va / 300) * 100)}%`;

    if (dom.readoutTe) dom.readoutTe.textContent = state.Te.toFixed(2);
    if (dom.progTe) dom.progTe.style.width = `${Math.min(100, (state.Te / 60) * 100)}%`;

    if (dom.readoutPin) dom.readoutPin.textContent = Math.round(state.Pin);
    if (dom.progPin) dom.progPin.style.width = `${Math.min(100, (state.Pin / 7500) * 100)}%`;

    // 2. Secondary Telemetry Badges
    if (dom.readoutEb) dom.readoutEb.textContent = `${state.Eb.toFixed(1)} V`;
    if (dom.readoutPcu) dom.readoutPcu.textContent = `${state.Pcu.toFixed(1)} W`;
    if (dom.readoutPout) dom.readoutPout.textContent = `${state.Pout.toFixed(1)} W`;
    if (dom.readoutEff) dom.readoutEff.textContent = `${state.efficiency.toFixed(1)} %`;

    // 3. Canvas HUD & Sub-gauges
    if (dom.hudOmega) dom.hudOmega.textContent = `${state.omega.toFixed(1)} rad/s`;
    if (dom.hudFlux) dom.hudFlux.textContent = `${state.flux.toFixed(2)} Wb`;
    if (dom.hudSparks) {
      if (state.sparkParticles.length > 5) {
        dom.hudSparks.textContent = 'HEAVY SPARKING ⚠️';
        dom.hudSparks.style.color = '#ef4444';
      } else if (state.sparkParticles.length > 0) {
        dom.hudSparks.textContent = 'MODERATE';
        dom.hudSparks.style.color = '#f59e0b';
      } else {
        dom.hudSparks.textContent = 'SAFE (NONE)';
        dom.hudSparks.style.color = '#10b981';
      }
    }

    const fluxPercent = Math.min(100, (state.flux / 2.5) * 100);
    if (dom.fluxFillBar) dom.fluxFillBar.style.width = `${fluxPercent}%`;
    if (dom.fluxPercentVal) dom.fluxPercentVal.textContent = `${fluxPercent.toFixed(1)}%`;

    const thermalPercent = Math.min(100, (state.Pcu / 1800) * 100);
    if (dom.thermalFillBar) dom.thermalFillBar.style.width = `${thermalPercent}%`;
    if (dom.thermalPercentVal) dom.thermalPercentVal.textContent = `${thermalPercent.toFixed(1)}%`;

    const rheoPercent = (state.R_starter / MACHINE.R_starter_max) * 100;
    if (dom.rheoFillBar) dom.rheoFillBar.style.width = `${rheoPercent}%`;
    if (dom.rheoVal) dom.rheoVal.textContent = `${state.R_starter.toFixed(1)} Ω`;

    if (dom.visFpsDisplay) dom.visFpsDisplay.textContent = `${fps.toFixed(1)} FPS`;

    // 4. Update Header Clock
    if (dom.clockDisplay) {
      const now = new Date();
      const ms = Math.floor(now.getMilliseconds() / 10).toString().padStart(2, '0');
      dom.clockDisplay.textContent = `${now.toTimeString().split(' ')[0]}.${ms}`;
    }

    // 5. Update Status Pill
    if (!state.breakerTripped) {
      if (!state.powerOn) {
        updateStatusPill('STANDBY // READY', 'normal');
      } else if (safetyState.isOvercurrentWarning) {
        updateStatusPill('WARNING: HIGH ARMATURE CURRENT', 'warning');
      } else if (safetyState.isOverspeedWarning) {
        updateStatusPill('WARNING: FLUX WEAKENING OVERSPEED', 'warning');
      } else if (safetyState.isStallCritical) {
        updateStatusPill('HAZARD: ROTOR STALLED UNDER LOAD', 'danger');
      } else {
        updateStatusPill('NORMAL OPERATION', 'normal');
      }
    }

    // 6. Update Live Engineering Insight Text
    updateEngineeringInsight();
  }

  function updateStatusPill(text, mode) {
    if (!dom.mainStatusPill || !dom.pillStatusText) return;
    dom.pillStatusText.textContent = text;
    dom.mainStatusPill.className = `status-indicator-pill ${mode}`;
    if (dom.systemBeacon) {
      dom.systemBeacon.className = `scada-beacon ${mode === 'danger' ? 'danger active' : 'active'}`;
    }
  }

  // ==========================================================================
  // 11. LIVE ENGINEERING INSIGHT ENGINE
  // ==========================================================================
  let lastInsightUpdate = 0;
  function updateEngineeringInsight() {
    const now = performance.now();
    if (now - lastInsightUpdate < 400) return; // Update every 400ms for readability
    lastInsightUpdate = now;

    if (!dom.insightText) return;

    if (state.breakerTripped) {
      dom.insightText.innerHTML = `<strong>RELAY TRIP TRIPPED:</strong> ${state.tripReason} Reset relay or lower load before restarting.`;
      return;
    }

    if (!state.powerOn) {
      dom.insightText.innerHTML = `Motor contactor is <strong>OPEN</strong>. Armature speed is decelerating due to viscous friction (B = ${MACHINE.B} N·m·s/rad). Click <strong>"START MOTOR"</strong> or press <strong>[P]</strong> to energize.`;
      return;
    }

    if (state.R_starter > 0.5) {
      dom.insightText.innerHTML = `<strong>3-POINT SOFT STARTER ACTIVE:</strong> Starting rheostat is currently adding <strong>${state.R_starter.toFixed(1)} Ω</strong> in series with Ra. This suppresses the dangerous 300A inrush surge while rotor develops Back EMF (Eb).`;
      return;
    }

    if (state.If < 0.40) {
      dom.insightText.innerHTML = `<strong>FLUX WEAKENING RUNAWAY:</strong> Field current is severely reduced (If = ${state.If.toFixed(2)} A). Stator flux Φ has collapsed to ${state.flux.toFixed(2)} Wb. To balance Va, the rotor must accelerate to extreme RPM (${Math.round(state.rpm)} RPM), entering the danger zone!`;
      return;
    }

    if (state.T_load > 35.0) {
      dom.insightText.innerHTML = `<strong>HEAVY MECHANICAL LOAD:</strong> High dynamometer torque (${state.T_load.toFixed(1)} Nm) is slowing the rotor. The drop in speed reduces Back EMF (Eb = ${state.Eb.toFixed(1)} V), which forces Armature Current Ia to spike to ${state.Ia.toFixed(1)} A to maintain torque equilibrium.`;
      return;
    }

    if (state.Va < 80.0 && state.rpm > 20) {
      dom.insightText.innerHTML = `<strong>ARMATURE VOLTAGE CONTROL (SUB-BASE SPEED):</strong> Operating below rated 240V. In this constant-torque region, speed N is directly proportional to applied voltage Va while stator flux Φ remains at rated saturation.`;
      return;
    }

    // Default Running Insight
    dom.insightText.innerHTML = `<strong>STEADY-STATE RUNNING:</strong> Counter-EMF ratio Eb/Va is <strong>${((state.Eb / (state.Va || 1)) * 100).toFixed(1)}%</strong>. Electromagnetic torque Te (${state.Te.toFixed(1)} Nm) precisely balances load torque Tload (${state.T_load.toFixed(1)} Nm) plus internal friction losses.`;
  }

  // ==========================================================================
  // 12. LAB OBSERVATIONS TABLE & AUTO-SWEEP ENGINE
  // ==========================================================================
  function recordCurrentReading() {
    let mode = 'General';
    if (state.activePreset === 'armature') mode = 'Va Control';
    else if (state.activePreset === 'field') mode = 'Field Weakening';
    else if (state.activePreset === 'load') mode = 'Load Test';
    else if (state.activePreset === 'starting') mode = 'Starting Surge';

    let status = 'Normal';
    if (state.breakerTripped) status = 'Tripped';
    else if (safetyState.isOvercurrentWarning) status = 'High Current';
    else if (safetyState.isOverspeedWarning) status = 'Overspeed';
    else if (state.rpm < 15 && state.powerOn) status = 'Stalled';

    const timeStr = new Date().toTimeString().split(' ')[0];

    const record = {
      sr: state.observations.length + 1,
      time: timeStr,
      mode: mode,
      va: Number(state.Va.toFixed(1)),
      ifVal: Number(state.If.toFixed(2)),
      load: Number(state.T_load.toFixed(1)),
      rpm: Math.round(state.rpm),
      ia: Number(state.Ia.toFixed(2)),
      eb: Number(state.Eb.toFixed(1)),
      te: Number(state.Te.toFixed(2)),
      pin: Math.round(state.Pin),
      pout: Math.round(state.Pout),
      pcu: Math.round(state.Pcu),
      eff: Number(state.efficiency.toFixed(1)),
      status: status
    };

    state.observations.push(record);

    // Also push into corresponding graph category
    if (state.activeGraphTab === 1) {
      state.graphPoints.tab1.push({ va: record.va, rpm: record.rpm });
    } else if (state.activeGraphTab === 2) {
      state.graphPoints.tab2.push({ ifVal: record.ifVal, rpm: record.rpm });
    } else if (state.activeGraphTab === 3) {
      state.graphPoints.tab3.push({ load: record.load, rpm: record.rpm, ia: record.ia });
    }

    renderObservationTable();
    calculateAnalyticalMetrics();
  }

  function renderObservationTable() {
    if (!dom.observationTableBody) return;

    if (state.observations.length === 0) {
      if (dom.emptyTableMessage) dom.emptyTableMessage.style.display = '';
      if (dom.obsCountBadge) dom.obsCountBadge.textContent = '0 READINGS RECORDED';
      return;
    }

    if (dom.emptyTableMessage) dom.emptyTableMessage.style.display = 'none';
    if (dom.obsCountBadge) dom.obsCountBadge.textContent = `${state.observations.length} READINGS RECORDED`;

    // Find peak efficiency index
    let peakEffIdx = -1;
    let maxEff = -1;
    state.observations.forEach((obs, idx) => {
      if (obs.eff > maxEff && obs.rpm > 100) {
        maxEff = obs.eff;
        peakEffIdx = idx;
      }
    });

    // Build rows HTML
    let html = '';
    state.observations.forEach((obs, idx) => {
      const isPeak = idx === peakEffIdx && maxEff > 0;
      const statusClass = obs.status === 'Normal' ? 'normal' : (obs.status === 'Tripped' ? 'danger' : 'warning');

      html += `
        <tr class="${isPeak ? 'peak-eff' : ''}">
          <td class="col-sr">${obs.sr}</td>
          <td class="col-time">${obs.time}</td>
          <td class="col-mode">${obs.mode}</td>
          <td class="col-va">${obs.va}</td>
          <td class="col-if">${obs.ifVal.toFixed(2)}</td>
          <td class="col-load">${obs.load.toFixed(1)}</td>
          <td class="col-speed" style="color: var(--cyan); font-weight:700;">${obs.rpm}</td>
          <td class="col-ia" style="color: var(--emerald);">${obs.ia.toFixed(2)}</td>
          <td class="col-eb">${obs.eb}</td>
          <td class="col-te">${obs.te.toFixed(2)}</td>
          <td class="col-pin">${obs.pin}</td>
          <td class="col-pout">${obs.pout}</td>
          <td class="col-pcu">${obs.pcu}</td>
          <td class="col-eff" style="font-weight:700;">${obs.eff}% ${isPeak ? '★' : ''}</td>
          <td class="col-status"><span class="badge-tag ${statusClass}">${obs.status}</span></td>
          <td class="col-del"><button class="col-del-btn" data-del="${idx}" title="Delete Reading">&times;</button></td>
        </tr>
      `;
    });

    dom.observationTableBody.innerHTML = html;

    // Attach row delete listeners
    dom.observationTableBody.querySelectorAll('.col-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const delIdx = parseInt(e.currentTarget.getAttribute('data-del'), 10);
        state.observations.splice(delIdx, 1);
        // Re-index
        state.observations.forEach((o, i) => o.sr = i + 1);
        renderObservationTable();
        calculateAnalyticalMetrics();
      });
    });
  }

  function calculateAnalyticalMetrics() {
    if (!dom.anaPeakEff || !dom.anaRegulation) return;

    if (state.observations.length === 0) {
      dom.anaPeakEff.textContent = '—';
      dom.anaRegulation.textContent = '—';
      return;
    }

    // 1. Peak efficiency
    let maxEff = 0;
    state.observations.forEach(o => {
      if (o.eff > maxEff) maxEff = o.eff;
    });
    dom.anaPeakEff.textContent = maxEff > 0 ? `${maxEff.toFixed(1)}%` : '0.0%';

    // 2. Speed Regulation: (N_nl - N_fl) / N_fl * 100
    // Search for near no-load (< 2 Nm) and full-load (23 to 27 Nm) with same Va and If
    let noLoadObs = state.observations.find(o => o.load <= 1.0 && o.rpm > 500);
    let fullLoadObs = state.observations.find(o => o.load >= 24.0 && o.load <= 26.0 && o.rpm > 500);

    if (noLoadObs && fullLoadObs) {
      const reg = ((noLoadObs.rpm - fullLoadObs.rpm) / fullLoadObs.rpm) * 100;
      dom.anaRegulation.textContent = `${reg.toFixed(1)}% (Nnl=${noLoadObs.rpm}, Nfl=${fullLoadObs.rpm})`;
    } else {
      dom.anaRegulation.textContent = 'Record No-Load (0 Nm) & Full-Load (25 Nm) to calculate';
    }
  }

  /**
   * Automated Multi-Step Sweep Execution
   */
  async function runAutoSweep() {
    if (state.isAutoSweeping) return;
    state.isAutoSweeping = true;

    // Ensure motor is powered
    if (!state.powerOn) {
      state.powerOn = true;
      updateHeaderButtons();
    }

    if (dom.anaSweepStatus) dom.anaSweepStatus.textContent = 'SWEEP IN PROGRESS...';

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Choose sweep steps based on active graph tab
    if (state.activeGraphTab === 1) {
      // Speed vs Va Sweep: 40V to 240V in 6 steps
      const vaSteps = [40, 80, 120, 160, 200, 240];
      state.If_target = 1.50;
      state.T_load_target = 10.0;
      updateSliderUI();

      for (let i = 0; i < vaSteps.length; i++) {
        state.Va_target = vaSteps[i];
        if (dom.sliderVa) dom.sliderVa.value = state.Va_target;
        if (dom.valVaDisplay) dom.valVaDisplay.textContent = state.Va_target.toFixed(1);
        if (dom.anaSweepStatus) dom.anaSweepStatus.textContent = `SWEEPING Va = ${state.Va_target}V (${i + 1}/${vaSteps.length})...`;
        await sleep(750); // Wait for rotor acceleration ODE to settle
        recordCurrentReading();
      }
    } else if (state.activeGraphTab === 2) {
      // Speed vs If Sweep: 2.2A down to 0.6A in 6 steps
      const ifSteps = [2.20, 1.80, 1.50, 1.20, 0.90, 0.60];
      state.Va_target = 200;
      state.T_load_target = 5.0;
      updateSliderUI();

      for (let i = 0; i < ifSteps.length; i++) {
        state.If_target = ifSteps[i];
        if (dom.sliderIf) dom.sliderIf.value = state.If_target;
        if (dom.valIfDisplay) dom.valIfDisplay.textContent = state.If_target.toFixed(2);
        if (dom.anaSweepStatus) dom.anaSweepStatus.textContent = `SWEEPING If = ${state.If_target}A (${i + 1}/${ifSteps.length})...`;
        await sleep(750);
        recordCurrentReading();
      }
    } else if (state.activeGraphTab === 3) {
      // Mechanical Load Sweep: 0 Nm to 30 Nm in 6 steps
      const loadSteps = [0.0, 6.0, 12.5, 18.0, 25.0, 30.0];
      state.Va_target = 240;
      state.If_target = 1.50;
      updateSliderUI();

      for (let i = 0; i < loadSteps.length; i++) {
        state.T_load_target = loadSteps[i];
        if (dom.sliderLoad) dom.sliderLoad.value = state.T_load_target;
        if (dom.valLoadDisplay) dom.valLoadDisplay.textContent = state.T_load_target.toFixed(1);
        if (dom.anaSweepStatus) dom.anaSweepStatus.textContent = `SWEEPING Load = ${state.T_load_target}Nm (${i + 1}/${loadSteps.length})...`;
        await sleep(800);
        recordCurrentReading();
      }
    } else {
      // Tab 4 Oscilloscope: test pulse
      state.T_load_target = 0.0;
      await sleep(500);
      state.T_load_target = 25.0;
      await sleep(1000);
      recordCurrentReading();
    }

    if (dom.anaSweepStatus) dom.anaSweepStatus.textContent = 'SWEEP COMPLETE (POINTS PLOTTED)';
    state.isAutoSweeping = false;
  }

  function exportObservationsCsv() {
    if (state.observations.length === 0) {
      alert('Observation table is empty. Click "RECORD READING" or run "AUTO-SWEEP" before exporting.');
      return;
    }

    const headers = [
      'Sr. No.', 'Time', 'Experiment Mode', 'Va (V)', 'If (A)', 'Load (Nm)',
      'Speed (RPM)', 'Ia (A)', 'Eb (V)', 'Torque Te (Nm)', 'Pin (W)',
      'Pout (W)', 'Pcu (W)', 'Efficiency (%)', 'Status'
    ];

    const rows = state.observations.map(o => [
      o.sr, `"${o.time}"`, `"${o.mode}"`, o.va, o.ifVal, o.load,
      o.rpm, o.ia, o.eb, o.te, o.pin, o.pout, o.pcu, o.eff, `"${o.status}"`
    ]);

    let csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'simulab_dc3000_lab_report.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function printLabReport() {
    const printDate = document.getElementById('printDate');
    if (printDate) printDate.textContent = new Date().toLocaleString();
    window.print();
  }

  function clearObservationsTable() {
    if (state.observations.length === 0) return;
    if (confirm('Clear all logged lab observations and plotted reference points?')) {
      state.observations = [];
      state.graphPoints.tab1 = [];
      state.graphPoints.tab2 = [];
      state.graphPoints.tab3 = [];
      renderObservationTable();
      calculateAnalyticalMetrics();
    }
  }

  // ==========================================================================
  // 13. GUIDED EXPERIMENT PRESETS
  // ==========================================================================
  function applyGuidedPreset(presetKey) {
    state.activePreset = presetKey;

    document.querySelectorAll('.guided-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === presetKey);
    });

    switch (presetKey) {
      case 'armature':
        // Exp 1: Armature Voltage Control (Speed vs Va)
        state.Va_target = 180.0;
        state.If_target = 1.50; // Constant rated field
        state.T_load_target = 5.0;
        state.softStarterEnabled = true;
        state.powerOn = true;
        switchGraphTab(1);
        break;

      case 'field':
        // Exp 2: Field Weakening & Runaway
        state.Va_target = 200.0;
        state.If_target = 0.90; // Reduced field
        state.T_load_target = 2.0;
        state.softStarterEnabled = true;
        state.powerOn = true;
        switchGraphTab(2);
        break;

      case 'load':
        // Exp 3: Mechanical Load Test
        state.Va_target = 240.0;
        state.If_target = 1.50;
        state.T_load_target = 20.0;
        state.softStarterEnabled = true;
        state.powerOn = true;
        switchGraphTab(3);
        break;

      case 'starting':
        // Exp 4: Direct-On-Line Surge vs Soft Starter
        state.powerOn = false;
        state.softStarterEnabled = false; // Disable starter to allow full DOL inrush!
        state.Va_target = 240.0;
        state.If_target = 1.50;
        state.T_load_target = 0.0;
        switchGraphTab(4); // Switch to oscilloscope to view starting spike
        break;
    }

    updateSliderUI();
    updateHeaderButtons();
  }

  function updateSliderUI() {
    if (dom.sliderVa) dom.sliderVa.value = state.Va_target;
    if (dom.valVaDisplay) dom.valVaDisplay.textContent = state.Va_target.toFixed(1);

    if (dom.sliderIf) dom.sliderIf.value = state.If_target;
    if (dom.valIfDisplay) dom.valIfDisplay.textContent = state.If_target.toFixed(2);

    if (dom.sliderLoad) dom.sliderLoad.value = state.T_load_target;
    if (dom.valLoadDisplay) dom.valLoadDisplay.textContent = state.T_load_target.toFixed(1);
  }

  function updateHeaderButtons() {
    if (dom.powerLed && dom.powerBtnText && dom.powerSwitch) {
      if (state.powerOn) {
        dom.powerLed.className = 'btn-led on';
        dom.powerBtnText.textContent = 'STOP MOTOR';
        dom.powerSwitch.classList.add('active-state');
      } else {
        dom.powerLed.className = 'btn-led off';
        dom.powerBtnText.textContent = 'START MOTOR';
        dom.powerSwitch.classList.remove('active-state');
      }
    }

    if (dom.starterLed && dom.starterBtnText && dom.starterToggle) {
      if (state.softStarterEnabled) {
        dom.starterLed.className = 'btn-led on';
        dom.starterBtnText.textContent = 'STARTER: ENGAGED';
        dom.starterToggle.classList.add('active-state');
      } else {
        dom.starterLed.className = 'btn-led off';
        dom.starterBtnText.textContent = 'STARTER: BYPASSED (DOL)';
        dom.starterToggle.classList.remove('active-state');
      }
    }

    if (dom.breakerLed && dom.breakerBtnText && dom.breakerToggle) {
      if (state.autoBreakerEnabled) {
        dom.breakerLed.className = 'btn-led on';
        dom.breakerBtnText.textContent = 'RELAY: ARMED';
        dom.breakerToggle.classList.add('active-state');
      } else {
        dom.breakerLed.className = 'btn-led off';
        dom.breakerBtnText.textContent = 'RELAY: OVERRIDDEN';
        dom.breakerToggle.classList.remove('active-state');
      }
    }
  }

  function switchGraphTab(tabNum) {
    state.activeGraphTab = tabNum;
    document.querySelectorAll('.graph-tab-btn').forEach(btn => {
      const isTab = parseInt(btn.getAttribute('data-tab'), 10) === tabNum;
      btn.classList.toggle('active', isTab);
      btn.setAttribute('aria-selected', isTab.toString());
    });

    const l1 = document.getElementById('legendLabel1');
    const chip2 = document.getElementById('legendChip2');
    const chip3 = document.getElementById('legendChip3');

    if (tabNum === 1) {
      if (l1) l1.textContent = 'Speed N (RPM)';
      if (chip2) chip2.classList.add('hidden');
      if (chip3) chip3.classList.add('hidden');
    } else if (tabNum === 2) {
      if (l1) l1.textContent = 'Speed N (RPM)';
      if (chip2) chip2.classList.add('hidden');
      if (chip3) chip3.classList.add('hidden');
    } else if (tabNum === 3) {
      if (l1) l1.textContent = 'Speed N (RPM)';
      if (chip2) chip2.classList.remove('hidden');
      if (chip3) chip3.classList.add('hidden');
    } else if (tabNum === 4) {
      if (l1) l1.textContent = 'Speed N';
      if (chip2) chip2.classList.remove('hidden');
      if (chip3) chip3.classList.remove('hidden');
    }
  }

  // ==========================================================================
  // 14. EVENT LISTENERS & KEYBINDINGS
  // ==========================================================================
  function setupEventListeners() {
    // 1. Armature Voltage Slider & Buttons
    if (dom.sliderVa) {
      dom.sliderVa.addEventListener('input', (e) => {
        state.Va_target = parseFloat(e.target.value);
        if (dom.valVaDisplay) dom.valVaDisplay.textContent = state.Va_target.toFixed(1);
      });
    }

    const stepVa = (delta) => {
      state.Va_target = Math.max(0, Math.min(300, state.Va_target + delta));
      if (dom.sliderVa) dom.sliderVa.value = state.Va_target;
      if (dom.valVaDisplay) dom.valVaDisplay.textContent = state.Va_target.toFixed(1);
    };

    document.getElementById('stepVaMinus10')?.addEventListener('click', () => stepVa(-10));
    document.getElementById('stepVaMinus1')?.addEventListener('click', () => stepVa(-1));
    document.getElementById('stepVaPlus1')?.addEventListener('click', () => stepVa(1));
    document.getElementById('stepVaPlus10')?.addEventListener('click', () => stepVa(10));

    document.querySelectorAll('[data-va]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const val = parseFloat(e.currentTarget.getAttribute('data-va'));
        state.Va_target = val;
        if (dom.sliderVa) dom.sliderVa.value = val;
        if (dom.valVaDisplay) dom.valVaDisplay.textContent = val.toFixed(1);
        document.querySelectorAll('[data-va]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
      });
    });

    // 2. Field Current Slider & Buttons
    if (dom.sliderIf) {
      dom.sliderIf.addEventListener('input', (e) => {
        state.If_target = parseFloat(e.target.value);
        if (dom.valIfDisplay) dom.valIfDisplay.textContent = state.If_target.toFixed(2);
      });
    }

    const stepIf = (delta) => {
      state.If_target = Math.max(0.0, Math.min(2.5, state.If_target + delta));
      if (dom.sliderIf) dom.sliderIf.value = state.If_target;
      if (dom.valIfDisplay) dom.valIfDisplay.textContent = state.If_target.toFixed(2);
    };

    document.getElementById('stepIfMinus10')?.addEventListener('click', () => stepIf(-0.1));
    document.getElementById('stepIfMinus1')?.addEventListener('click', () => stepIf(-0.01));
    document.getElementById('stepIfPlus1')?.addEventListener('click', () => stepIf(0.01));
    document.getElementById('stepIfPlus10')?.addEventListener('click', () => stepIf(0.1));

    document.querySelectorAll('[data-if]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const val = parseFloat(e.currentTarget.getAttribute('data-if'));
        state.If_target = val;
        if (dom.sliderIf) dom.sliderIf.value = val;
        if (dom.valIfDisplay) dom.valIfDisplay.textContent = val.toFixed(2);
        document.querySelectorAll('[data-if]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
      });
    });

    // 3. Mechanical Dynamometer Load Slider & Buttons
    if (dom.sliderLoad) {
      dom.sliderLoad.addEventListener('input', (e) => {
        state.T_load_target = parseFloat(e.target.value);
        if (dom.valLoadDisplay) dom.valLoadDisplay.textContent = state.T_load_target.toFixed(1);
      });
    }

    const stepLoad = (delta) => {
      state.T_load_target = Math.max(0, Math.min(50, state.T_load_target + delta));
      if (dom.sliderLoad) dom.sliderLoad.value = state.T_load_target;
      if (dom.valLoadDisplay) dom.valLoadDisplay.textContent = state.T_load_target.toFixed(1);
    };

    document.getElementById('stepLoadMinus5')?.addEventListener('click', () => stepLoad(-5));
    document.getElementById('stepLoadMinus1')?.addEventListener('click', () => stepLoad(-1));
    document.getElementById('stepLoadPlus1')?.addEventListener('click', () => stepLoad(1));
    document.getElementById('stepLoadPlus5')?.addEventListener('click', () => stepLoad(5));

    document.querySelectorAll('[data-load]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const val = parseFloat(e.currentTarget.getAttribute('data-load'));
        state.T_load_target = val;
        if (dom.sliderLoad) dom.sliderLoad.value = val;
        if (dom.valLoadDisplay) dom.valLoadDisplay.textContent = val.toFixed(1);
        document.querySelectorAll('[data-load]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
      });
    });

    // 4. Header Switches
    dom.powerSwitch?.addEventListener('click', () => {
      audio.init();
      if (state.breakerTripped) {
        alert('Circuit breaker is tripped! Click "RESET" before restarting motor.');
        return;
      }
      state.powerOn = !state.powerOn;
      updateHeaderButtons();
    });

    dom.starterToggle?.addEventListener('click', () => {
      state.softStarterEnabled = !state.softStarterEnabled;
      updateHeaderButtons();
    });

    dom.breakerToggle?.addEventListener('click', () => {
      state.autoBreakerEnabled = !state.autoBreakerEnabled;
      updateHeaderButtons();
    });

    dom.audioToggle?.addEventListener('click', () => {
      audio.init();
      const isAud = audio.toggleMute();
      if (dom.audioStatusText) dom.audioStatusText.textContent = isAud ? 'AUDIO: ON' : 'AUDIO: MUTED';
      dom.audioToggle.classList.toggle('muted', !isAud);
    });

    document.getElementById('resetBreakerBtn')?.addEventListener('click', resetCircuitBreaker);
    document.getElementById('bannerResetBtn')?.addEventListener('click', resetCircuitBreaker);
    document.getElementById('estopBtn')?.addEventListener('click', emergencyStop);
    document.getElementById('bannerDismissBtn')?.addEventListener('click', () => {
      document.getElementById('safetyBanner')?.classList.add('hidden');
    });

    // 5. Visualizer View Tabs
    document.getElementById('tabVisPhysical')?.addEventListener('click', () => {
      state.visMode = 'physical';
      document.getElementById('tabVisPhysical').classList.add('active');
      document.getElementById('tabVisSchematic').classList.remove('active');
      document.getElementById('canvasOverlayHud')?.classList.remove('hidden');
    });

    document.getElementById('tabVisSchematic')?.addEventListener('click', () => {
      state.visMode = 'schematic';
      document.getElementById('tabVisSchematic').classList.add('active');
      document.getElementById('tabVisPhysical').classList.remove('active');
      document.getElementById('canvasOverlayHud')?.classList.add('hidden');
    });

    // 6. Graph Tabs
    document.querySelectorAll('.graph-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabNum = parseInt(e.currentTarget.getAttribute('data-tab'), 10);
        switchGraphTab(tabNum);
      });
    });

    document.getElementById('btnToggleTheoretical')?.addEventListener('click', (e) => {
      state.showTheoretical = !state.showTheoretical;
      e.currentTarget.querySelector('span').textContent = state.showTheoretical ? 'REF CURVE: ON' : 'REF CURVE: OFF';
    });

    document.getElementById('btnClearPlotPoints')?.addEventListener('click', () => {
      if (state.activeGraphTab === 1) state.graphPoints.tab1 = [];
      else if (state.activeGraphTab === 2) state.graphPoints.tab2 = [];
      else if (state.activeGraphTab === 3) state.graphPoints.tab3 = [];
    });

    // 7. Guided Presets
    document.querySelectorAll('.guided-preset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const preset = e.currentTarget.getAttribute('data-preset');
        applyGuidedPreset(preset);
      });
    });

    // 8. Observation Log Sheet Actions
    document.getElementById('btnRecordObservation')?.addEventListener('click', recordCurrentReading);
    document.getElementById('btnAutoSweep')?.addEventListener('click', runAutoSweep);
    document.getElementById('btnExportCsv')?.addEventListener('click', exportObservationsCsv);
    document.getElementById('btnPrintReport')?.addEventListener('click', printLabReport);
    document.getElementById('btnClearTable')?.addEventListener('click', clearObservationsTable);

    // 9. Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Avoid firing when user is typing inside an input
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        recordCurrentReading();
      } else if (e.key === 'p' || e.key === 'P') {
        dom.powerSwitch?.click();
      } else if (e.key === 'e' || e.key === 'E') {
        emergencyStop();
      } else if (e.key === 's' || e.key === 'S') {
        dom.starterToggle?.click();
      } else if (e.key === 'm' || e.key === 'M') {
        dom.audioToggle?.click();
      } else if (e.key === 'r' || e.key === 'R') {
        resetCircuitBreaker();
      }
    });
  }

  // ==========================================================================
  // 15. MAIN CONTINUOUS 60-FPS ANIMATION & SIMULATION LOOP
  // ==========================================================================
  let lastTimestamp = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let currentFps = 60.0;

  function mainLoop(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const elapsed = (timestamp - lastTimestamp) / 1000.0;
    lastTimestamp = timestamp;

    // Fixed integration dt with clamping to prevent spiral of death on background tab
    const dt = Math.min(0.033, Math.max(0.005, elapsed));

    // FPS calculation
    frameCount++;
    fpsTimer += elapsed;
    if (fpsTimer >= 0.5) {
      currentFps = (frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
    }

    // 1. Step Physical Differential Equations
    stepPhysics(dt);

    // 2. Synthesize Audio Hum & Alarms
    const isAlarmActive = safetyState.isOvercurrentCritical || 
                          safetyState.isOverspeedCritical || 
                          safetyState.isFieldLossCritical ||
                          safetyState.isStallCritical ||
                          state.breakerTripped;
    audio.update(state.rpm, state.Ia, isAlarmActive);

    // 3. Render Visualizer Canvas (View A or View B)
    renderVisualizer();

    // 4. Render Multi-Tabbed Graph Canvas
    renderGraph();

    // 5. Sync SCADA DOM Readouts
    updateDomTelemetry(currentFps);

    requestAnimationFrame(mainLoop);
  }

  // ==========================================================================
  // 16. INITIALIZATION
  // ==========================================================================
  function init() {
    setupEventListeners();
    updateSliderUI();
    updateHeaderButtons();
    renderObservationTable();

    // Start 60 FPS animation loop
    requestAnimationFrame(mainLoop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
