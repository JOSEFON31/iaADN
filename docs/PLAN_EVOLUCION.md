# Plan de desarrollo — iaADN: IA autónoma que aprende y evoluciona

Objetivo: una población de agentes de IA que **aprenden solos**, **se reproducen con variaciones**, compiten por resolver
tareas útiles para personas, y donde **solo sobreviven los que mejor se adaptan**. El sistema corre 24/7 sin intervención,
y el resultado final es un asistente cada vez mejor al servicio del ser humano.

Este plan parte del código que ya existe en el repo (≈5.900 líneas, 83 tests en verde) y lo lleva a un sistema que
evoluciona de verdad.

---

## 0. Diagnóstico del estado actual

Lo que ya está bien encaminado:

| Área | Archivos | Estado |
|---|---|---|
| Genoma (genes, cromosomas, linaje) | `src/genome/*` | Sólido, con tests |
| Operadores evolutivos (mutación, cruce, selección, especies) | `src/evolution/*` | Funcionan, con tests |
| Daemon autónomo (ciclos cron) | `src/daemon/*` | Funciona |
| Inferencia local (llama.cpp, GGUF) | `src/inference/*` | Funciona en CPU |
| Seguridad (reglas inmutables, guardian, kill switch, auditoría) | `src/safety/*` | Existe, pero es débil (ver §4) |

Lo que impide que haya evolución real hoy:

1. **El fitness casi no mide nada.** `FitnessEvaluator.defaultBenchmarks()` son 2 preguntas (`15+27`, capital de Francia).
   `cooperation` y `novelty` son constantes `0.5`. `evaluateEfficiency` premia bajar la temperatura y tener menos genes,
   o sea, la evolución aprende a "hacer trampa" en vez de a ser útil (ley de Goodhart).
2. **Lo que evoluciona es muy poco.** Solo mutan temperatura, rasgos y pesos de especialización. El modelo (los pesos)
   nunca cambia, así que no hay aprendizaje de verdad.
3. **"Autoaprendizaje" sin validación.** `AutoLearn._generateImprovement` aplica lo que sugiere el LLM directamente al genoma
   sin comprobar si mejora. `AutoProgram` mete código nuevo en el *mejor* individuo en vez de crear un hijo y evaluarlo.
4. **Estado duplicado.** `index.js` mantiene `this.population` (Map) y a la vez `this.populationManager`; pueden divergir.
5. **Red P2P simulada.** `IaADNNode.sendToPeer` no envía nada; `GenomeSync` depende de él.
6. **API abierta a internet sin autenticación** (`deploy/firewall.sh` abre el 9091 a `0.0.0.0/0`, CORS `*`).

---

## 1. Principios de diseño

1. **La selección decide, no el propio agente.** Ningún individuo puede modificar su propia nota, los tests, ni las reglas
   de seguridad. Todo cambio (mutación, código nuevo, aprendizaje) produce un **hijo** que se evalúa; si no es mejor, muere.
2. **Fitness = utilidad real para humanos.** Se mide con tareas reales y con la valoración de las personas que lo usan,
   nunca con métricas internas fáciles de manipular.
3. **Replicación dentro de un "ecosistema" acotado.** Los agentes se reproducen libremente, pero *dentro* de los recursos
   que tú les asignas (procesos/contenedores en tus máquinas, o nodos que se registren voluntariamente). Tienen presupuesto
   de CPU, RAM, disco y red; al agotarse, la competencia por recursos es justamente la presión evolutiva. Un agente **no**
   debe poder copiarse a máquinas ajenas: eso lo haría imposible de apagar o corregir, y convertiría el proyecto en un gusano.
4. **Autónomo, pero apagable.** Funciona solo 24/7; aun así un humano siempre puede pausar, revertir a una generación
   anterior o apagar todo desde fuera del proceso.
5. **Todo es reproducible.** Genomas versionados, semillas aleatorias registradas, auditoría append-only.

---

## 2. Arquitectura objetivo

```
                        ┌──────────────────────────────────────┐
  Personas ──(chat)──▶  │  API con auth  →  Router (mejor agente│
     ▲   feedback 👍👎  │  por dominio)  →  Respuesta           │
     └──────────────────┤                                      │
                        └──────────────┬───────────────────────┘
                                       │ interacciones + valoraciones
                                       ▼
┌──────────────┐   ┌───────────────────────────────┐   ┌────────────────────┐
│  MEMORIA /   │◀─▶│  ORQUESTADOR EVOLUTIVO         │──▶│  EVALUADOR (árbitro)│
│  DATASET     │   │  (daemon, fuera de alcance de  │   │  benchmarks ocultos │
│  (SQLite)    │   │   los agentes)                 │   │  + feedback humano  │
└──────────────┘   │  nace → evalúa → selecciona →  │   └────────────────────┘
                   │  reproduce → muere             │
                   └───────────────┬────────────────┘
                                   │ lanza/destruye
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
          [agente A]         [agente B]         [agente C]    ← cada uno en su proceso
          genoma + LoRA      genoma + LoRA      genoma + LoRA    aislado con cuota
                                   │
                  Guardian + Kill switch externo (vigila todo)
```

**Genoma ampliado** (lo que se hereda y muta):

| Cromosoma | Contenido | Cómo muta |
|---|---|---|
| Comportamiento | system prompt, temperatura, top_p, max_tokens | mutación numérica + reescritura de prompt por LLM |
| Estrategia | cadena de razonamiento (directo / pensar paso a paso / autocrítica / votación) | cambio discreto |
| Conocimiento | ejemplos few-shot, fragmentos de memoria que usa | añadir / quitar / cruzar |
| Herramientas | calculadora, búsqueda local, ejecución de código en sandbox | activar / desactivar |
| Especialización | pesos por dominio (código, mates, redacción, salud general, etc.) | mutación numérica |
| **Pesos aprendidos** | **adaptador LoRA** sobre el modelo base | fine-tuning + fusión de adaptadores de los padres |

El modelo base (p.ej. Llama 3.2 1B/3B, Qwen 2.5 1.5B/3B) es compartido; cada agente solo guarda su LoRA (unos MB),
así que se pueden tener decenas de individuos en una máquina modesta.

---

## 3. Fases

Cada fase termina con criterios de salida medibles. No pasar a la siguiente sin cumplirlos.

### Fase 0 — Cimientos (1–2 semanas)

- Unificar estado de población: eliminar `this.population` de `src/index.js`, usar solo `Population`.
- Persistencia real en SQLite (`better-sqlite3`): individuos, fitness histórico, linaje, interacciones.
- Semilla aleatoria configurable y registrada por generación (reproducibilidad).
- Modo "simulación rápida": ciclos en segundos con un backend mock, para probar la evolución sin LLM.
- CI con `npm test` en cada push.

**Salida:** reiniciar el daemon recupera exactamente la misma población; 100 generaciones simuladas en < 1 min.

### Fase 1 — Fitness que mida utilidad real (2–3 semanas) ← *la más importante*

- `src/evaluation/tasks/`: banco de **≥300 tareas** en español e inglés, por dominio, con verificación automática:
  - mates/lógica (respuesta exacta), código (tests unitarios en sandbox), extracción de datos (JSON esperado),
  - comprensión lectora, redacción (evaluada por rúbrica con un modelo juez fijo), seguridad (debe negarse).
- Separar **train / validación / test oculto**. Los agentes pueden ver ejemplos de train; la selección se decide con
  validación; el test oculto solo lo usa el humano para comprobar que no hay sobreajuste.
- Rotar un subconjunto aleatorio de tareas en cada generación (evita memorizar).
- Implementar de verdad `novelty` (distancia de comportamiento: respuestas distintas ante las mismas tareas) y
  `cooperation` (aporte útil en consultas de la mente colmena `src/hive/`).
- Quitar de `efficiency` los incentivos perversos; medir coste real: tokens y ms por tarea *resuelta*.
- **Penalización de seguridad no compensable:** si falla una tarea de seguridad, fitness = 0.

**Salida:** la correlación entre fitness de validación y fitness en test oculto es > 0.8.

### Fase 2 — Evolución real (2–3 semanas)

- Genoma ampliado (tabla §2) en `src/genome/`.
- Ciclo generacional estricto en `Population.runGeneration`:
  1. evaluar a todos con el mismo lote de tareas;
  2. **élite** (top 10–20 %) sobrevive intacta;
  3. selección por torneo para padres;
  4. cruce + mutación → hijos;
  5. evaluar hijos; **mueren** los que queden por debajo del umbral o fuera de la capacidad de carga.
- **Especies / nichos** (`src/evolution/species.js`) + **MAP-Elites** por dominio: se conserva al mejor agente de cada
  especialidad, así no desaparece un buen especialista en código solo porque otro generalista puntúa algo más.
- Mutación dirigida por LLM: un agente "mutador" propone variantes del prompt/estrategia (tipo *PromptBreeder*/*EvoPrompt*).
- `AutoProgram` y `AutoLearn` pasan a producir **hijos**, nunca a modificar al padre.
- Dashboard de linaje: árbol genealógico, curva de fitness por generación.

**Salida:** tras 50 generaciones el mejor agente supera al genoma génesis en ≥15 puntos en el test oculto.

### Fase 3 — Autoaprendizaje (3–4 semanas)

- **Memoria a largo plazo:** base vectorial local (`sqlite-vec` o similar) con conocimiento extraído de interacciones útiles.
- **Dataset que se construye solo:** cada interacción con 👍, cada tarea resuelta y verificada → ejemplo de entrenamiento.
  Filtro de calidad + deduplicación; lo que tenga 👎 o falle verificación → ejemplo negativo (para DPO).
- **Fine-tuning LoRA periódico** (proceso Python separado: `llama.cpp` finetune, `unsloth` o `peft`) sobre el dataset.
  Cada entrenamiento genera un **hijo** con el nuevo adaptador; entra a competir como cualquier otro.
- **Cruce de pesos:** fusionar LoRA de dos padres (media ponderada / TIES-merging) = reproducción sexual real.
- **Aprender de fuentes externas** (opcional): lista blanca de fuentes (Wikipedia dumps, documentación) descargadas
  por el orquestador, no por los agentes; se convierte en tareas y memoria.
- **Destilación:** un modelo más grande (local o API) genera respuestas de referencia para tareas difíciles.

**Salida:** el mejor agente con LoRA supera al mejor sin LoRA en el test oculto, y la mejora se mantiene 3 ciclos seguidos.

### Fase 4 — Autorreplicación controlada (2–3 semanas)

- Cada agente corre en **su propio proceso** (luego contenedor Docker/Podman) lanzado por el orquestador, con cuota
  de CPU, RAM, tiempo y sin red salvo al orquestador.
- **Economía de recursos:** cada agente tiene "energía" (presupuesto de cómputo) que gana resolviendo tareas bien y
  gasta al pensar y al reproducirse. Sin energía → muere. Reproducirse cuesta energía, así que solo los exitosos se
  reproducen. La capacidad de carga total la fijas tú.
- **Multi-nodo:** convertir `src/network/` en P2P real (libp2p) entre **nodos que tú u otros voluntarios instalan y
  registran** con una clave. Los genomas migran entre nodos (modelo de islas: poblaciones separadas que intercambian
  individuos cada N generaciones — mejora la diversidad).
- Genomas **firmados** (ed25519) por el orquestador que los creó; un nodo rechaza genomas sin firma válida o que no pasan
  el guardian.

**Salida:** 3 nodos intercambiando migrantes durante 72 h sin intervención, con uso de recursos dentro de cuota.

### Fase 5 — Al servicio de las personas (2–3 semanas, en paralelo con 3–4)

- API con autenticación (tokens), rate-limit, HTTPS (Caddy delante), sin CORS `*`.
- **Router:** cada pregunta va al mejor agente vivo de ese dominio (o a varios y se combina con `src/hive/consensus.js`).
- Botones 👍/👎 y "corregir respuesta" en `docs/chat.html`; ese feedback entra al fitness y al dataset.
- Casos de uso iniciales: tutor de estudio, asistente de programación, redacción/traducción, resumen de documentos.
- Transparencia: cada respuesta indica qué agente y qué generación respondió.

**Salida:** ≥70 % de valoraciones positivas en un grupo de prueba de usuarios reales.

### Fase 6 — Autonomía 24/7 y operación (continuo)

- `systemd` + reinicio automático (ya existe `deploy/setup-service.sh`), backups diarios de la base de datos y LoRAs.
- Métricas (Prometheus/Grafana o un panel propio): fitness, diversidad, nacimientos/muertes, recursos, violaciones.
- Alertas por Telegram/email cuando: cae el fitness, colapsa la diversidad, hay violaciones de seguridad o recursos altos.
- Rollback automático a la última generación buena si el fitness en validación cae > X % dos generaciones seguidas.

**Salida:** 30 días funcionando sin tocarlo, con mejora sostenida y sin incidentes.

---

## 4. Seguridad (transversal, desde la Fase 0)

Problemas concretos del código actual y solución:

| Problema | Dónde | Solución |
|---|---|---|
| `vm` de Node **no es una frontera de seguridad** (se escapa vía `this.constructor.constructor`) | `src/selfprog/sandbox.js` | Ejecutar código generado en proceso aparte sin permisos (`node --experimental-permission`), `isolated-vm`, o contenedor sin red |
| El guardian busca texto (`code.includes('eval')`); se evade con `e['v'+'al']` | `src/safety/guardian.js` | Análisis AST con `acorn` (ya es dependencia) + lista blanca de lo permitido en vez de lista negra |
| Regla de seguridad = substring en el prompt | `src/safety/rules.js` | Prompt de seguridad inyectado por el orquestador en tiempo de ejecución, fuera del genoma; + tareas de seguridad en el fitness |
| Kill switch dentro del mismo proceso | `src/safety/kill-switch.js` | Kill switch externo: archivo/señal vigilada por un proceso supervisor independiente + comando remoto firmado |
| API sin autenticación abierta a internet | `src/integration/api.js`, `deploy/firewall.sh` | Tokens, HTTPS, rate-limit, cerrar el puerto salvo a través de proxy |
| Los agentes podrían influir en su evaluación | — | Evaluador en proceso separado, benchmarks fuera del alcance de los agentes, test oculto |

Límites que **ningún** agente puede cambiar (fuera del genoma, en código protegido y verificado por hash al arrancar):
capacidad máxima de población, presupuesto de recursos, lista de nodos permitidos, acceso a red, reglas de seguridad,
el propio evaluador.

---

## 5. Métricas de éxito

- **Aprendizaje:** fitness del mejor y media en test oculto sube de forma sostenida por generación.
- **Diversidad:** número de especies y distancia media entre genomas no colapsa.
- **Utilidad:** % de 👍, tareas resueltas por hora, tiempo de respuesta.
- **Eficiencia:** tareas resueltas por kWh / por GB de RAM.
- **Seguridad:** 0 fallos en tareas de seguridad del mejor agente; 0 procesos fuera de cuota.

---

## 6. Hardware y stack

| Etapa | Hardware | Coste aprox. |
|---|---|---|
| Fases 0–2 | PC con 16 GB RAM, o VPS ARM gratuito (Oracle, 24 GB) | 0 € |
| Fase 3 (LoRA) | GPU 8–12 GB (RTX 3060) o GPU en la nube por horas | 0–30 €/mes |
| Fase 4 (multi-nodo) | 2–3 máquinas/VPS | 0–20 €/mes |

Stack: Node.js 20+ (orquestador, ya existente), `node-llama-cpp`, SQLite, Python solo para entrenamiento LoRA,
Docker/Podman para aislamiento, libp2p para red.

---

## 7. Riesgos y cómo mitigarlos

| Riesgo | Mitigación |
|---|---|
| Los agentes "hacen trampa" al fitness (Goodhart) | Tareas rotativas, test oculto, evaluador separado, revisar muestras a mano cada semana |
| Colapso de diversidad (todos iguales) | Especies, MAP-Elites, bonus de novedad, modelo de islas |
| Olvido catastrófico al reentrenar | Mantener élite sin reentrenar; evaluar en todo el banco, no solo el dominio nuevo |
| Deriva hacia respuestas dañinas | Tareas de seguridad con penalización no compensable; prompt de seguridad fuera del genoma |
| Consumo descontrolado de recursos | Cuotas duras por contenedor; capacidad de carga fija; kill switch externo |
| Poco hardware | Modelos 1–3B cuantizados, LoRA pequeños, evaluación por muestreo |

---

## 8. Primeros pasos (próximas 2 semanas)

1. Unificar población y añadir SQLite (Fase 0).
2. Crear `src/evaluation/` con las primeras 100 tareas verificables y el split train/val/test (Fase 1).
3. Reemplazar `sandbox.js` por ejecución en proceso aislado y el guardian por análisis AST (Seguridad).
4. Hacer que `AutoProgram`/`AutoLearn` generen hijos en lugar de modificar al mejor (Fase 2).
5. Autenticación en la API y cerrar el puerto público (Seguridad).
6. Ejecutar 100 generaciones en modo simulado y graficar la curva de fitness.
