> Plan de entrenamiento de incoming mixups para la rama `frame-meter`.
> Copia canónica: `kofxi_aw_modding/docs/plans/plan-incoming-savestate.md`.
> Loop de vida baja (opcional): `kofxi_aw_modding/docs/plans/plan-incoming-training.md`.

# Plan — Incoming trainer dentro del ISO (snapshot de pelea, tamaño medido)

Fecha: 2026-11-26. Alcance: KOF XI PS2 JP (`SLPS-25660`), hack de práctica que se
empaqueta en el ISO (PPF / `make_combo_dmg_ps2.py`). Objetivo: guardar el estado
en cualquier frame y recargarlo después del incoming, para repetir el mismo
mixup. Un slot. Save y Load en botones distintos.

> Hermano: `kofxi_aw_modding/docs/plans/plan-incoming-training.md` (loop de vida baja). Con este plan, el
> loop pasa a ser opcional.

---

## 1. Corrección importante: 580 KB era una ventana, no el delta

La primera medición (“restaurar `0x92F000–0x9C0000` funciona”) era una **ventana
cruda segura**. Medí lo que realmente cambia durante un KO → incoming y es mucho
menor:

| Región | Bytes cambiados en ~206 frames | Qué es |
|---|---:|---|
| `0x930000–0x940000` | **3.658 B (~3,6 KB)** | los 6 structs de personaje |
| `0x9B0000–0x9C0000` | **412 B** | equipos, cámara, ronda, score, input |
| `0x8F0000–0x900000` | 6.912 B | stage/efectos |
| `0x870000–0x890000` | ~32 KB | efectos del KO/incoming |
| `0x900000–0x930000` | ~186 KB | **scratch gráfico por frame (probable; no hace falta para la pelea)** |
| `0x410000–0x440000` | ~60 KB | buffer de audio/archivos |

Prueba clave: un snapshot crudo de solo **132 KB** (región A `0x930000–0x940000`
+ región B `0x9AF000–0x9C0000` + flags) reproduce **equipos y personajes activos
exactos durante 120 frames**. El `0x900000–0x930000` que cambia cada frame es
scratch de dibujo y **no hace falta** para la lógica de pelea.

**Si se guarda en el DOWN** (decisión del usuario, para fijar el frame activo y el
recovery del golpe), hay que añadir la **región E `0x870000–0x890000`** (efectos
del KO). Probado: snapshot crudo de **260 KB** (A+B+E+flags) en el down reproduce
**equipos, personajes activos y efectos exactos durante 180 frames** (animación
de KO + recovery + incoming). Bytes realmente cambiados en esa ventana: A ~5,9 KB,
B ~0,9 KB, E ~33 KB → un snapshot compacto sería ~**40 KB**.

Conclusión:

- **En el down:** ~**260 KB** crudo, o ~**40 KB** compacto.
- **En el inicio del incoming:** ~**132 KB** crudo, o ~**6 KB** compacto.
- **580 KB:** no se necesita; era la ventana conservadora.

---

## 2. Proyectiles: no están dentro del struct del personaje

- Cada personaje es un struct de 0x600 B en `*(team+0x78+slot*4)+0x10`.
- Un proyectil es una **tarea**: el nodo está en la lista fija (`0x9B07E0`) y su
  **bloque de datos** está aparte, asignado del heap.
- Para conservar proyectiles/efectos hay que guardar:
  - la lista y los nodos de tareas (región B), y
  - los bloques de datos de las tareas vivas, o una ventana de heap donde caigan.

Por eso el diseño no guarda “todo el heap”: guarda la zona de tareas/equipo y,
si hace falta, los bloques vivos. Sigue siendo muy inferior a 580 KB.

---

## 3. Diseño propuesto (un slot, manual, dos botones)

### 3.1 Contenido del slot (v1, crudo simple)

```
slot {
    u8  regA[0x10000];   // 0x930000..0x940000: los 6 structs de personaje
    u8  regB[0x11000];   // 0x9AF000..0x9C0000: tareas, equipos, cámara, ronda, input
    u8  regE[0x20000];   // 0x870000..0x890000: efectos del down/KO
    u32 game_flags;      // 0x1D4D918
    // Fase 0 decide si hace falta:
    //   + bloques de tareas vivas (proyectiles) fuera de A/B/E
}
```

- Tamaño v1 (down): **260 KB** (266.244 B).
- v2 compacta (solo bytes cambiados): **~40 KB**.
- Si se guardara en el inicio del incoming, sin regE: ~132 KB (o ~6 KB compacto).
- Se descarta `0x900000–0x930000` (scratch gráfico) y `0x410000–0x440000`
  (audio/archivos).

### 3.2 Storage

- 260 KB no es un problema: reservar `0x42000` con el allocator del juego
  (`FUN_001A4B80` es candidato) o usar un bloque fijo libre.
- El code cave del ELF solo guarda el código y un puntero.
- v2 compacta (~40 KB) sigue necesitando allocator o un bloque libre; no cabe en
  los huecos actuales del zero run (el mayor es ~21 KB).

### 3.3 Save / Load

- **SAVE** (botón A): copiar regA + regB + regE + flags al slot.
- **LOAD** (botón B): copiar de vuelta.
- Entre frames; nunca a mitad de una tarea.
- No se ejecuta `QUICK RESET`: se conserva el estado crudo (proyectiles incluidos
  si están en las regiones/bloques guardados).
- Tras LOAD: `QT` limpia freeze/hitstop si quedó pegado; el latch de input está
  dentro de regB, así que no debería disparar un botón fantasma.

**Punto de guardado (decidido): el DOWN.**

- Fija el frame activo y el **recovery del golpe que tumbó**, que es lo que
  condiciona el timing del mixup.
- Incluye regE (efectos del down) para que la secuencia down → KO → incoming se
  repita.
- Probado: A+B+E+flags en el down reproduce equipos, personajes activos y
  efectos **exactos durante 180 frames**.
- Coste: cada repetición vuelve a ver la animación de KO (~86 frames) antes del
  incoming; es el precio de fijar el recovery.

### 3.4 Botones

- Dos funciones nuevas de **KEY SETTING** (como QUICK RESET = 14): **SAVE = 15**
  y **LOAD = 16**, con etiquetas en el atlas (misma técnica que ENEMY/QUICK/RESET).
- Alternativa: dos valores nuevos en SELECT BUTTON de práctica.
- Sin auto-save en v1.

---

## 4. Plan por fases

### Fase 0 — Cerrar el estado mínimo y proyectiles (recomp) — 3–5 días

- [x] Probar guardar **en el down** con A+B+E+flags: 260 KB reproducen equipos,
      personajes activos y efectos exactos durante 180 frames.
- [ ] Medir el delta de un **KO con proyectil** (personaje con proyectil, guardar
      en el down, cargar, verificar que el proyectil/efecto se repite).
- [ ] Identificar dónde caen los bloques de tareas de proyectiles/efectos
      (heap) y decidir: ventana fija extra o copiar bloques vivos por lista de
      tareas.
- [ ] Probar 300–600 frames de replay con input del jugador después del load.
- [ ] Probar la variante compacta (mapa de bytes dinámicos) para bajar de 260 KB
      a ~40 KB.
- [ ] Listar globales fuera de regA/regB/regE que afecten la pelea (p. ej. RNG).
- [ ] Validar el allocator y el tamaño final.

**Salida:** slot final (260 KB crudo o ~40 KB compacto) con proyectil validado
y 300–600 frames de replay correcto.

### Fase 1 — Save/Load básico en el ISO — 1–2 semanas

- [ ] `patch_savestate()` en `make_combo_dmg_ps2.py` (keystone, `opt_asm`,
      asserts de región cero).
- [ ] Reservar el slot con el allocator al primer save; puntero en el cave.
- [ ] `SAVE`/`LOAD` con `memcpy` MIPS entre frames.
- [ ] Enganchar a dos funciones de KEY SETTING (15/16).
- [ ] Etiquetas SAVE/LOAD en el atlas.
- [ ] Probar en PCSX2: practice, VS, cold boot, 20 save/load seguidos.

**Salida:** SAVE en el down, LOAD tras el incoming, repetible, con proyectiles.

### Fase 2 — Integración de menú y pulido — 1 semana

- [ ] Opciones en el menú de práctica (si no quedaron en KEY SETTING).
- [ ] Feedback: sonido + “SAVED” / “LOADED”.
- [ ] Manejo de errores (allocator falla, LOAD sin slot).
- [ ] Protección contra doble pulsación / pausa / editor de comandos.

### Fase 3 — Hardware y cierre — 1 semana

- [ ] Cold boot, todos los modos, 2P, stage 3D, cambio de personaje, pausa.
- [ ] PS2 real si hay; PCSX2 2.8.x como referencia.
- [ ] Actualizar `combo-damage-ps2/README.md`, plan maestro y PPF.

**Total v1: ~4–5 semanas.**

---

## 5. Criterios de aceptación

| Prueba | Criterio |
|---|---|
| Repetición exacta | SAVE en el down, LOAD tras el incoming: mismas posiciones/acciones/vida y mismo timing |
| Proyectil | un KO causado por proyectil se repite igual tras LOAD |
| Repetible | 20 SAVE/LOAD seguidos sin desincronizar |
| No rompe | cold boot, practice, VS, pausa, menú, 2P, stage 3D |
| Rendimiento | SAVE/LOAD < 1 frame; sin bajón de fps |
| Regresión | los hacks existentes siguen funcionando |

---

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Proyectil/efecto fuera de regA/regB | Fase 0: medir; añadir ventana de efectos o copiar bloques vivos |
| Estado oculto (RNG/contadores) | Fase 0: 300–600 frames; globales extra |
| El allocator devuelve bloque dentro de regA/regB | comprobar puntero; pedir otro o bloque fijo |
| Freeze/hitstop pegado tras LOAD | `QT`, reset de freeze (`FUN_0017E850`, `0x9BB838/39`) |
| Botón fantasma | latch dentro de regB; 1 frame neutro tras LOAD |
| Cambio de versión (US) | mapa por versión; JP primero |
| Hardware real (EE cache) | parches estáticos, sin código en runtime |

---

## 7. Decisiones ya tomadas

1. **Save manual en cualquier frame**, pero el flujo objetivo es **guardar en el
   DOWN** para fijar el frame activo y el recovery del golpe.
2. **Un slot.**
3. **Load crudo, sin `QUICK RESET`** (conservar proyectiles/efectos).
4. **SAVE y LOAD en botones distintos.**
5. **La vida baja es aparte/opcional.**

Pendiente en Fase 0: si se queda el bloque crudo de 260 KB o el compacto de
~40 KB, y cómo se cubren los proyectiles que caigan fuera de regA/regB/regE.

---

## 8. Anexo — direcciones (JP `SLPS_25660`)

```
Región A:           0x930000..0x940000 (0x10000)  structs de los 6 personajes
Región B:           0x9AF000..0x9C0000 (0x11000)  tareas, equipos, cámara, ronda, input
Región E:           0x870000..0x890000 (0x20000)  efectos del down/KO
Game flags:         0x1D4D918
Scratch gráfico:    0x900000..0x930000 (NO guardar)
Audio/archivos:     0x410000..0x440000 (NO guardar)
Equipos:            0x9BDB50 (P1), 0x9BDD98 (P2), stride 0x248
  +0x0A team state
  +0x28..0x2A orden de miembros
  +0x150+i*0x20+4 vida del miembro i
  +0x78+i*4       puntero al nodo del miembro i
Personaje:          *(nodo+0x10) = struct 0x600 B; +0x4F0 bit 0x80 = muerto
Cámara:             0x9BDB20
Ronda:              0x9BDA40..0x9BDA80
Score:              0x9BD9B8
Practice:           0x9CB240.. ; LIFE 0x9CB245
Allocator:          0x156070 (tareas), 0x1A4B80 (bloques grandes)
QUICK RESET:        QRC 0x3AF540, QT 0x3AF900
Zero run ELF:       0x3A2D72..0x3B34BC (usado hasta ~0x3B2F00)
```

Pruebas: `kofxi-env/examples/delta_map.c` (mide bytes cambiados),
`down_state_probe.c` (260 KB en el down, teams/chars/efectos exactos),
`small_state_probe.c` (132 KB, teams/chars exactos),
`partial_state_probe.c`, `loop_probe.c`, `ko_probe.c`.

---

## 9. Flujo de uso (el pedido)

1. Practice, P2 como dummy.
2. Jugar normal. En el frame del **DOWN** (cuando el rival cae), pulsar **SAVE**.
3. Ver la animación de KO + el incoming y practicar el mixup.
4. Pulsar **LOAD**: vuelve exactamente al frame del down.
5. Repetir.

- El SAVE fija el **frame activo** y el **recovery** del golpe que tumbó.
- Cada repetición vuelve a ver la animación de KO (~86 frames) antes del incoming.
- La vida baja no es necesaria para este flujo; queda como modo opcional.
- SAVE y LOAD son botones distintos (decisión del usuario).

---

## 10. Receta de implementación (ISO)

### 10.1 Datos

```c
typedef struct {
    u8  regA[0x10000];   // 0x930000..0x940000
    u8  regB[0x11000];   // 0x9AF000..0x9C0000
    u8  regE[0x20000];   // 0x870000..0x890000
    u32 flags;           // 0x1D4D918
} kof_slot;              // 266.244 B
```

### 10.2 Reserva del buffer

- Al primer SAVE: `FUN_001A4B80(0x42000)` (allocator de bloques grandes).
- Guardar el puntero en el code cave (4 B).
- Validar: `ptr != 0` y `ptr` fuera de `0x870000–0x9C0000` (para no copiarse a sí
  mismo).
- Fallback: bloque fijo libre verificado en todos los modos.
- No liberar nunca.

### 10.3 Save / Load (pseudo)

```c
save:
    if (!slot) { slot = alloc(0x42000); if (!slot) { aviso; return; } }
    memcpy(slot->regA, 0x930000, 0x10000);
    memcpy(slot->regB, 0x9AF000, 0x11000);
    memcpy(slot->regE, 0x870000, 0x20000);
    slot->flags = *(u32*)0x1D4D918;

load:
    if (!slot) return;
    memcpy(0x930000, slot->regA, 0x10000);
    memcpy(0x9AF000, slot->regB, 0x11000);
    memcpy(0x870000, slot->regE, 0x20000);
    *(u32*)0x1D4D918 = slot->flags;
    /* 1 frame neutro + QT para limpiar freeze/hitstop si quedó pegado */
```

### 10.4 Punto de ejecución

- Handler de **KEY SETTING** / **SELECT BUTTON**, igual que `QUICK RESET`
  (`QRC 0x3AF540`, dispatch `0x33B41C`).
- Entre frames; nunca a mitad de una tarea.
- No guardar con pausa/menú/editor de comandos abiertos (o guardar igual y
  restaurar; decidir en Fase 1).
- Sin auto-save en v1.

### 10.5 Post-load

- El latch de input (`0x9BEA20` / `0x9BEA2C`) está dentro de regB, así que se
  restaura; si igual aparece un botón fantasma, limpiarlo y dejar 1 frame neutro.
- `QT` (`0x3AF900`) limpia el freeze/hitstop si quedó pegado.
- No ejecutar `QUICK RESET`: se pierden proyectiles/efectos.

### 10.6 Botones y etiquetas

- KEY SETTING: **SAVE = 15**, **LOAD = 16** (el vanilla ignora valores >= 13, así
  que los saves viejos siguen compatibles).
- Etiquetas en el atlas con `practice_labels.py`, misma técnica que
  ENEMY / QUICK / RESET.

---

## 11. Registro de mediciones (2026-11-26)

Entorno: recomp headless (`kofxi-env`), JP `SLPS-25660`, practice
`pr_fight900.state`. No es hardware real.

### 11.1 Comandos

```sh
cd kofxi-env
make build/delta_map build/down_state_probe build/small_state_probe build/loop_probe
cd ../ps2-web-recomp/games/kofxi-jp
../../../kofxi-env/build/delta_map $PWD ~/ps2_route/pr_fight900.state 1400
../../../kofxi-env/build/down_state_probe $PWD ~/ps2_route/pr_fight900.state
../../../kofxi-env/build/small_state_probe $PWD ~/ps2_route/pr_fight900.state practice
../../../kofxi-env/build/loop_probe $PWD ~/ps2_route/pr_fight900.state 3000
```

### 11.2 `delta_map` — qué cambia desde el DOWN

DOWN detectado en `n=705`, frame `6281`. Unión de bytes cambiados hasta `n=1400`
(~695 frames):

| Región | Bytes | Interpretación |
|---|---:|---|
| `0x930000–0x940000` | 5.874 | personajes |
| `0x9B0000–0x9C0000` | 948 | equipo/globales |
| `0x870000–0x880000` | 5.376 | efectos |
| `0x880000–0x890000` | 27.775 | efectos |
| `0x8F0000–0x900000` | 6.912 | stage/efectos |
| `0x900000–0x930000` | ~188.199 | scratch gráfico (no gameplay) |
| `0x410000–0x450000` | ~97.340 | audio/archivos |

Delta compacto de gameplay: **~40 KB** (personajes + equipo + efectos).

### 11.3 `down_state_probe` — snapshot en el DOWN

- Snapshot: A+B+E+flags = **260 KB**.
- Replay de **180 frames** desde el down (KO + recovery + incoming).
- Resultado: `teams ok`, `chars ok`, `E ok` todos los frames.
- `A`/`B` crudos divergen en bytes no-gameplay al +0; no afectan la pelea.

### 11.4 `small_state_probe` — snapshot en el inicio del incoming

- Snapshot: A+B+flags = **132 KB**.
- Replay de **120 frames**.
- Resultado: `teams ok`, `chars ok`.

### 11.5 `loop_probe` — loop de vida baja

- Con `LIFE=1` (`0x9CB245=1`) y `LOW=13` (≈12 %): decenas de KOs seguidos,
  ciclo `0→1→2→0`, sin fin de round.
- Sin limpiar `entity+0x4F0 & 0x80` el equipo queda trabado.
- Detalle: `kofxi_aw_modding/docs/plans/plan-incoming-training.md`.

### 11.6 `ko_probe` / `wrap_probe` — mecánica del KO

- El orden del equipo rota `[0,1,2]→[1,2,0]→[2,0,1]` en `team+0x28..0x2A`.
- El miembro actual es `team+0x28`.
- Al morir, la vida del miembro pasa a `-1` y el flag de muerto es
  `entity+0x4F0 & 0x80`.
- Revivir solo la vida (sin limpiar el flag) deja el equipo vivo pero trabado.

### 11.7 Límites de estas mediciones

- Todo en recomp; falta PCSX2 y hardware real.
- `0x900000–0x930000` se clasifica como scratch gráfico **porque la pelea se
  reproduce sin él**; falta identificar la función exacta que lo escribe.
- Falta el KO con proyectil (ver Fase 0).
- Los números son de `pr_fight900.state`; otro stage/personaje puede mover
  regiones (sobre todo efectos/proyectiles).

---

## 12. Apéndice — loop de vida baja (opcional)

Ya no es necesario para practicar con el snapshot, pero queda documentado como
modo de “volumen”:

1. Practice `LIFE=1` (`0x9CB245=1`); con RECOVERY el dummy no muere.
2. Por frame, lado rival:
   - si el miembro está muerto (`entity+0x4F0 & 0x80`) y **ya no es el actual**
     (`team+0x28 != i`): poner vida `LOW` y limpiar el bit `0x80`;
   - si está vivo y la vida > `LOW`: ponerla en `LOW`.
3. `LOW = 13` (≈12 % de 112).
4. El juego rota la cola solo; el round no termina mientras haya vivos.

Detalle completo: `kofxi_aw_modding/docs/plans/plan-incoming-training.md`.
