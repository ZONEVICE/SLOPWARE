# Informe de pruebas: Reptile 1.1.0 en Windows 10 real

Fecha: 2026-10-08/09. Máquina Windows: `ATUN` (192.168.0.246). Máquina Linux: `T14`
(192.168.0.241). Commit base probado: `6e9bcf9` (rama `master`). Todas las pruebas se
hicieron sin tocar el repo salvo este informe, `resultados-windows\` y, en la fase 5, el
código de Reptile. **No se hizo ningún commit.**

Datos en bruto citados: carpeta `resultados-windows\` (logs de `cargo test`/`npm test`,
`state-*.json`, logs de instancias, resultados de los escenarios, y evidencias de los fallos).

---

## 1. Resumen

**Reptile 1.1.0 funciona en Windows 10 real.** El núcleo —sincronización bidireccional en
tiempo real, Rust↔Rust, Rust↔Node y Node↔Node, por HTTP y HTTPS, en los dos sentidos— pasó
todas las pruebas cruzadas con Linux por la LAN (M1–M12), con convergencia byte a byte
(SHA-256), renombrados en el sitio (file ids de NTFS preservados), cambio de PIN, caída
brusca, descubrimiento y cierre limpio con Ctrl+C y con la X.

Se encontraron varios fallos/mejoras específicos de Windows y se **arreglaron seis**, en las
dos implementaciones donde la regla es compartida, con una prueba automática cada uno y sin
hacer ningún commit:
1. **Adaptadores virtuales** (ZeroTier, VMware, VirtualBox) no se excluían al elegir la
   dirección LAN → Reptile anunciaba una IP de VPN inalcanzable. Ahora anuncia la IP LAN real.
2. **Divergencia silenciosa** cuando el host modificaba un archivo bloqueado o de solo lectura
   en el peer (informaba "idéntico" sin reintentar). Ahora converge en ~1 s.
3. **Probe de descubrimiento** (Rust): `connect_timeout` de la stdlib clasifica mal y lento
   los puertos cerrados en Windows. Reescrito con WinSock (connect no bloqueante + `select` +
   `SO_ERROR`): clasifica `Closed` correctamente y responde en cuanto llega el RST.
4. **Watcher** (Rust): podía perder los cambios hechos justo tras arrancar (el primer
   `ReadDirectoryChangesW` se emitía tarde). Ahora `start` arma el watch de forma síncrona,
   como inotify. (Esto eliminó la inestabilidad del test del watcher.)
5. **Ciclo de reconciliación** con nombres que el peer no puede representar (`a:b.txt`,
   `aux.txt`, `trailing.`…): ahora se omiten como "no sincronizables", cortando el bucle y el
   round-trip del munging de Windows.
6. **Pruebas `npm test`** que asumían POSIX (permisos/rutas) hechas conscientes de la
   plataforma (gated a Windows, Linux intacto).

Tras los arreglos, **ambas suites pasan en Windows**: `cargo test` 152/152 y `npm test` 221
OK / 0 fallos / 3 omitidos (permisos POSIX) + `browser` omitido (sin Chromium).

Queda **un hallazgo sin arreglar** (documentado, con propuesta): archivos en rutas > ~260
caracteres no se indexan (límite MAX_PATH); su corrección correcta (rutas `\\?\` en toda la
capa de archivos) es un cambio transversal arriesgado para un caso poco común y la decide la
sesión de Linux.

**Un aviso de despliegue importante:** al arrancar `reptile.exe` por primera vez, Windows no
mostró el diálogo del cortafuegos sino que creó reglas de **bloqueo** silenciosas; sin
permitir la app a mano (o firmar el ejecutable), Reptile no recibe peers por la LAN.

Veredicto: **listo para Windows.** Los seis arreglos están verificados (pruebas automáticas y,
los relevantes, end-to-end por la LAN). Solo queda documentar al usuario lo del cortafuegos y
decidir sobre las rutas largas (poco común).

---

## 2. Entorno (fase 0)

(Datos completos en `resultados-windows\fase0-entorno.txt`.)

- **SO:** Windows 10 Pro 22H2, build 19045.7725, x64. Sesión **con privilegios de
  administrador**.
- **Herramientas:** Python 3.14.8, Node.js v24.21.0, npm 11.19.0, rustc/cargo 1.99.0,
  git 2.56. OpenSSL 3.5.9 (de Git, en `C:\Program Files\Git\ucrt64\bin`).
- **Toolchain de Rust:** por defecto `stable-x86_64-pc-windows-gnu`, **pero no hay `gcc` de
  MinGW**, así que el toolchain por defecto no enlaza. Sí está instalado Visual Studio 18
  Community y el toolchain `stable-x86_64-pc-windows-msvc`; se compiló con
  `cargo +stable-x86_64-pc-windows-msvc` (sin cambiar el toolchain por defecto). El `link.exe`
  del PATH es el de Git (coreutils), no el de MSVC.
- **Antivirus:** solo Windows Defender (tiempo real activo). No se desactivó.
- **Red:** interfaz LAN = Wi-Fi (TP-Link USB), 192.168.0.246/24, perfil **Público**.
  Cortafuegos: Domain/Private/Public los tres activos. Adaptadores virtuales **activos con
  IP**: Hyper-V `vEthernet (Default Switch)` 172.23.128.1 y **ZeroTier** 192.168.111.10;
  además varios `VirtualBox Host-Only` (desconectados) y dos Wi-Fi Direct (169.254).
- **Disco de trabajo:** D: NTFS, ~960 GB libres.
- **Reloj:** desfase con Linux de −11…−1 ms (muy por debajo de 1 s; Reptile resuelve
  conflictos por mtime).
- **Alcance:** los 5 puertos de Linux (55667-70 + agente 55690) accesibles por TCP; ICMP OK.

---

## 3. Tabla de resultados

Leyenda: ✅ pasa · ❌ fallo real · ⚠️ con matiz (esperado/plataforma) · ⓘ informativo.

| Prueba | Resultado | Tiempos / datos | Comentario |
| --- | --- | --- | --- |
| **Fase 1 · `cargo build` (MSVC)** | ✅ | 1m32s | `reptile.exe --version` = 1.1.0 |
| **Fase 1 · `cargo test`** (inicial) | ⚠️ 147/149 | — | fallaban `discovery` (H4) y `watcher` (H5); **arreglados en fase 5** |
| **Fase 1 · `cargo test`** (tras arreglos) | ✅ 152/152 | — | EXIT=0; clippy limpio |
| **Fase 1 · `npm test`** (inicial) | ⚠️ 215/221 | 28s | 6 fallos de plataforma (H6); **arreglados en fase 5** |
| **Fase 1 · `npm test`** (tras arreglos) | ✅ 221/0/3 | — | 0 fallos; 3 omitidos (permisos POSIX), browser omitido |
| **Fase 2 · `.exe` empaquetado** | ✅ | — | version/help OK |
| **Fase 2 · Cortafuegos** | ⚠️ | — | Windows crea reglas de BLOQUEO silenciosas; ver H2 |
| **Fase 2 · identidad/direcciones** | ❌→✅ | — | elegía ZeroTier como IP LAN; ver H1 (arreglado) |
| **Fase 2.5 · Ctrl+C / cerrar ventana** | ✅ | 4.5s / 3.7s | el peer pasa a `stopped`, no `reconnecting` |
| **W1 · huella + same_directory** | ✅ | — | 400 `same_directory` en ambos sentidos |
| **W2 · local Rust/Node ×4** | ✅ | r0–r2 0.5–1.5s | 4 combinaciones, 3 rondas |
| **W3 · renombrado en el sitio** | ✅ | — | file id NTFS idéntico (archivo y dir) |
| **W4 · archivo bloqueado** | ❌→✅ | 1s tras soltar | divergía en silencio; ver H3 (arreglado) |
| **W5 · solo lectura** | ❌→✅ | 1s | divergía en silencio; ver H3 (arreglado) |
| **W6 · nombres y rutas** | ⚠️ | CPU ~0.09s | sin caída/bucle; `leaf` >260 no se indexa; ver H7 |
| **W7 · rutas con / y \\** | ✅ | — | ambas aceptadas y normalizadas (Rust y Node) |
| **W8 · rendimiento + Defender** | ⓘ | 36s / 10019 arch | referencia; Defender penaliza muchos archivos |
| **M1 · LinuxRust→WinRust (hostile)** | ✅⚠️ | live 32.6s | W3 cruzado OK; asimetría de nombres esperada; ver H8 |
| **M2 · WinRust→LinuxRust** | ✅ | r0 0.1 r1 7.1 r2 55s | |
| **M3 · LinuxNode→WinRust** | ✅ | live 53.9s | |
| **M4 · WinRust→LinuxNode** | ✅ | r0 0.1 | |
| **M5 · LinuxRust→WinNode** | ✅ | live 21.4s | Node peer en Windows |
| **M6 · WinNode→LinuxRust** | ✅ | live 11.2s | Node host en Windows |
| **M7 · Rust⇄Rust HTTPS (2 sent.)** | ✅ | r0–r2 ok | |
| **M8 · Node⇄Rust HTTPS (2 sent.)** | ✅ | r0–r2 ok | acepta el cert autofirmado del otro |
| **M9 · cambio de PIN** | ✅ | pin_required 0.0s, live 0.4s | PIN erróneo 403; intercambio reanuda |
| **M10 · caída brusca** | ✅ | sesión liberada 22.8s | peer→reconnecting; UUID nuevo→stopped (diseño) |
| **M11 · descubrimiento** | ✅ | ≤1s / 2.3s | ambos lados ven 4 instancias; HTTP compatible, HTTPS no |
| **M12 · rendimiento LAN** | ⓘ | 248s / 214s | 10019 arch + 128MB por Wi-Fi |

---

## 4. Hallazgos

### H1 — Los adaptadores virtuales de Windows no se excluían al elegir la dirección LAN  — **IMPORTANTE — ARREGLADO**
- **Qué hice:** arrancar una instancia y mirar `GET /api/state.identity` y el banner.
- **Qué esperaba:** la dirección LAN = la Wi-Fi real (192.168.0.246).
- **Qué pasó:** `identity.address` = `192.168.111.10` (ZeroTier, VPN), y el banner mostraba
  `peers connect 192.168.111.10:55667`. `addresses` incluía ZeroTier además de la Wi-Fi. Rust
  y Node coincidían. (Hyper-V `vEthernet` y las 169.254 sí se excluían.)
- **Evidencia:** `resultados-windows\state-fase2-rust-http.json`, `inst-rust-http-55667.log`.
- **Causa:** el filtro compara por prefijo del nombre; en Windows los nombres son los
  *FriendlyName* del adaptador ("ZeroTier One [...]"), que no empiezan por `zt`.
- **Gravedad:** importante (un peer de la LAN real no puede alcanzar la IP anunciada; la
  sincronización manual dando la IP a mano no se ve afectada).
- **Arreglado:** sí, en las dos implementaciones (ver §6 y `cambios-windows.md` arreglo 1).
  Verificado: el banner del build nuevo dice `peers connect 192.168.0.246`.

### H2 — El cortafuegos de Windows crea reglas de BLOQUEO silenciosas (no muestra el diálogo)  — **INFORMATIVO (despliegue)**
- **Qué hice:** arrancar `reptile.exe` sin reglas previas y mirar el cortafuegos.
- **Qué esperaba:** el diálogo "¿Permitir acceso?".
- **Qué pasó:** no apareció diálogo; Windows creó dos reglas entrantes **Block** ("Query
  User{GUID}...reptile.exe", TCP y UDP, perfiles Private+Public). Como las reglas Block ganan
  a las Allow, el entrante quedó bloqueado hasta borrarlas.
- **Evidencia:** `resultados-windows\fase2-resumen.txt`; la prueba inversa Linux→Windows daba
  timeout hasta borrar los Block, luego `status 200`.
- **Gravedad:** informativo, pero relevante para el usuario final: Reptile no recibe peers por
  la LAN hasta permitir la app. En una sesión interactiva normal el usuario vería el diálogo;
  aquí (admin, no interactivo) quedó en Block.
- **Causa:** comportamiento de Windows con apps no firmadas/no permitidas.
- **No es un fallo de Reptile.** Propuesta: documentarlo en el README/instalador (instruir a
  permitir la app) o firmar el ejecutable.

### H3 — Divergencia silenciosa al no poder reemplazar un archivo bloqueado o de solo lectura (W4, W5)  — **IMPORTANTE — ARREGLADO**
- **Qué hice:** en el peer, abrir un archivo en exclusiva (W4) o ponerlo `+R` (W5) mientras el
  host lo modificaba.
- **Qué esperaba:** que tras soltar/actualizar, el peer convergiera; o que fallara con
  reintento, sin caerse.
- **Qué pasó (antes):** no convergía (probado 121 s en W4, 30 s en W5); el peer informaba
  "live: both copies are identical" (falso); el log no decía nada; un cambio en otro archivo no
  lo reparaba; solo se arreglaba si ese mismo archivo volvía a cambiar en el host. Sin caída.
- **Evidencia:** `resultados-windows\fase3-resumen.txt` (W4/W5).
- **Causa:** `commit` hace `rename(temp, destino)`, que en Windows falla si el destino es de
  solo lectura o está bloqueado; y una escritura en vivo fallida se ignoraba (no agendaba
  reconciliación), dejando índice≠disco. En Linux no pasa (POSIX). En Node, además, el índice
  quedaba apuntando al estado nuevo y el temporal no se descartaba.
- **Gravedad:** importante (divergencia de datos informada como sincronizada).
- **Arreglado:** sí, en las dos implementaciones (ver §6 y `cambios-windows.md` arreglo 2).
  Verificado end-to-end (Rust y Node): W5 converge en ~1 s; W4 converge en ~1 s al soltar.

### H4 — El probe de descubrimiento (Rust) clasificaba mal y lento los puertos cerrados en Windows  — **IMPORTANTE (rendimiento) — ARREGLADO**
- **Qué hice:** ejecutar `cargo test` (falla `discovery::the_probe_tells_closed_ports...`) y un
  diagnóstico aparte.
- **Qué esperaba:** un puerto cerrado → `Closed`, al instante.
- **Qué pasó:** en Windows `std::net::TcpStream::connect_timeout` a un puerto cerrado devuelve
  `kind=TimedOut` (os=None, sintetizado) y **consume el timeout completo** (~700 ms); se
  clasifica `Unreachable` en vez de `Closed`. Un `connect()` bloqueante sí da
  `ConnectionRefused` (os=10061) pero tarda ~2 s.
- **Evidencia:** `resultados-windows\fail-discovery.txt`, `probe-connect-timeout.txt`.
- **Causa:** limitación conocida de `connect_timeout` en Windows (usa select esperando
  escribibilidad; un rechazo aparece en el conjunto de error y se reporta como timeout).
- **Impacto:** el **descubrimiento de instancias reales SÍ funciona** (M11: puertos abiertos
  conectan rápido y se detectan en ≤1 s). Lo que degrada es el barrido de puertos/hosts
  cerrados (cada uno cuesta el timeout entero) y su clasificación. El probe de **Node no tiene
  el problema** (`discovery.test.js` pasa en Windows).
- **Gravedad:** menor para funcionalidad, importante para rendimiento del escaneo.
- **Arreglado (solo Rust, `#[cfg(windows)]`):** `tcp_check` reescrito con WinSock (socket no
  bloqueante + `connect` + `select` sobre los conjuntos de escritura y error +
  `getsockopt(SO_ERROR)`): distingue `WSAECONNREFUSED` (Closed) de timeout (Unreachable) y responde
  en cuanto llega el RST. Clave: leer `WSAGetLastError()` justo tras `connect` (liberar memoria
  resetea el last-error). El test se hizo tolerante al loopback lento de Windows (mide ~2050 ms para
  un puerto recién cerrado): sigue fallando sin el arreglo (daría Unreachable) y pasa con él.
  Ver §6 y `cambios-windows.md` arreglo 3.

### H5 — El watcher podía perder cambios hechos justo tras arrancar (visible como test inestable)  — **IMPORTANTE (robustez) — ARREGLADO**
- **Qué hice:** `cargo test` y repeticiones del target del watcher.
- **Qué pasó:** con la suite completa (17 watchers `ReadDirectoryChangesW` en paralelo) un test
  del watcher falla ~5/6 veces, y **uno distinto cada vez** (p. ej.
  `a_file_replaced_by_a_directory...`, `deleting_a_file...`): pérdida/retraso de eventos por
  contención. Con `--test-threads=1` pasan los 17 de forma fiable (3/3); en aislamiento también.
- **Evidencia:** `resultados-windows\watcher-flakiness.txt`.
- **Causa:** `OsWatch::start` abría el handle pero el primer `ReadDirectoryChangesW` se emitía
  DENTRO del hilo lector; bajo carga el hilo tardaba en arrancar y se perdían los cambios
  tempranos. inotify (Unix) arma el watch de forma síncrona en `start`; Windows no.
- **Gravedad:** importante como robustez (un cambio justo al empezar a hospedar/sincronizar en
  Windows podía perderse hasta el rescan periódico); se manifestaba como test inestable.
- **Arreglado (solo Rust, `#[cfg(windows)]`):** `start` espera a que el hilo lector esté vivo y a
  punto de emitir el primer `ReadDirectoryChangesW` antes de retornar (misma garantía que inotify).
  Verificado: el target del watcher pasa 6/6 veces en paralelo (antes ~1/6). Ver §6 y
  `cambios-windows.md` arreglo 4.

### H6 — 6 pruebas de `npm test` asumían POSIX (permisos/rutas)  — **PLATAFORMA (tests) — ARREGLADO**
- **Qué pasó:** `cert.test.js:32` (espera la clave privada en 0o600; Windows no aplica permisos
  POSIX → 0o666); `lib.test.js` (`resolveWirePath('/srv/share','a/b')` da la ruta local del SO
  `D:\srv\share\a\b`, el test fija POSIX); `paths.test.js` (casing de realpath `Temp`/`TEMP`;
  `chmod 0o000`/no-escritura no restringen en Windows → no se dan `unreadable`/`not_writable`).
- **Evidencia:** `resultados-windows\npm-test.txt`, `fase1-resumen.txt`.
- **Valoración:** son limitaciones de los TESTS en Windows (POSIX), no del producto; pasan en
  Linux. La corrección de las wire paths de red (con `/`) está verificada por los cruces
  (M1–M8 sincronizan byte a byte) y por `interop.rs`. Nota menor de seguridad: la clave del
  certificado efímero no queda en 0o600 en Windows (Windows no lo soporta vía Node).
- **Arreglado (solo tests, gated a Windows):** la asersión de modo `0o600` del cert solo se
  comprueba fuera de Windows; `resolveWirePath` usa fixtures con unidad en Windows; `result.path`
  se compara sin distinguir mayúsculas; los tres tests que dependen de `chmod` POSIX se omiten en
  Windows (escenario no reproducible). Linux queda intacto. Nota de plataforma: la clave del cert
  efímero no queda restringida por modo en Windows. Ver §6 y `cambios-windows.md` arreglo 6.

### H7 — Archivos en rutas > ~260 caracteres no se indexan (W6)  — **MENOR (limitación) — NO ARREGLADO**
- **Qué pasó:** con un directorio de ruta total 278 car. creado con `\\?\`, Reptile **creó los
  directorios** en el peer (hasta 278 car.) pero **no indexó el archivo** `leaf.txt` dentro
  (el host contó 5 de 6 archivos) → no se sincroniza, en silencio. `con.txt`/`aux.txt`
  (reservados) se indexan pero el peer no puede crearlos (tolerados). **Sin caída ni bucle.**
- **Evidencia:** `resultados-windows\fase3-resumen.txt` (W6).
- **Causa:** no se usa el prefijo `\\?\` para abrir archivos muy profundos (límite MAX_PATH).
- **Gravedad:** menor (rutas tan largas son raras; no hay caída). **Propuesta:** usar rutas
  extendidas (`\\?\`) en el acceso a archivos en Windows, si se quiere soportar > 260 car.

### H8 — Ciclo de reconciliación con nombres que Windows no puede representar (M1)  — **MENOR — ARREGLADO**
- **Qué pasó:** con `--hostile`, Windows **recorta el punto final** de `trailing.` → el archivo
  quedaba como `trailing` (contenido presente, nombre distinto) y hacía round-trip. Con nombres
  incompatibles presentes (`a:b.txt`, `aux.txt`, …), el log del peer mostraba un **ciclo**
  `synchronising → live: identical` cada ~2-3 s (reconciliación que no se estabilizaba); en los
  escenarios limpios (M2-M6) no ocurría. Sin caída.
- **Evidencia:** `resultados-windows\fase4-resumen.txt` (M1), `cross-m1.json`.
- **Gravedad:** menor (desgaste de CPU/red al sincronizar un directorio con nombres que un lado no
  puede representar; sin pérdida de datos ni caída).
- **Arreglado (regla compartida):** se añadió `is_os_representable`/`isOsRepresentable` (en Windows,
  falso para caracteres reservados, punto/espacio final y nombres de dispositivo) y el predicado de
  "saltar" de la sincronización la usa, de modo que el planner omite esos nombres (como los no
  compartidos): no reintenta ni deja que `trailing.` haga round-trip. Complementa el filtro de
  caracteres que ya tenía `normalizeWirePath`. Pruebas en Rust y Node. Ver §6 y
  `cambios-windows.md` arreglo 5.

---

## 5. Cambios hechos en esta PC

| Cambio | Detalle | ¿Deshecho? |
| --- | --- | --- |
| Regla de cortafuegos | `New-NetFirewallRule "Reptile-xtest"` Inbound TCP 55667-55690 Allow Any | Sí (fase 7) |
| Reglas de bloqueo de Windows | Borradas las "Query User{...}reptile.exe" (Block TCP+UDP) que Windows auto-creó al arrancar la app (y las que reaparecieron al reiniciar instancias) | Borradas durante la prueba; anotadas en `scratch\system-changes.txt` |
| Directorio scratch | `D:\reptile-xtest-scratch\` (target de cargo, certs de Node, árboles de prueba, binarios de diagnóstico) | Sí (fase 7) |
| Variables de entorno | `CARGO_TARGET_DIR`, `REPTILE_CERT_DIR`, `REPTILE_OPENSSL`, `REPTILE_SKIP_BROWSER_TESTS` — solo dentro de cada comando, **no** persistentes (no se usó `setx`) | Nada que deshacer |
| Procesos | Instancias `reptile.exe`/`node` de prueba (puertos 55667-55670, 55681-55682) | Sí (fase 7) |
| Instalaciones | **Ninguna** (se usó lo ya instalado: VS18, Rust, Node, Python, OpenSSL) | — |
| Toolchain por defecto de Rust | **No cambiado** (se usó `cargo +stable-x86_64-pc-windows-msvc`) | — |
| Perfil de red / Defender | **No tocados** | — |

No se crearon archivos `*.sync-conflict-*`. No se modificó `.git`.

---

## 6. Arreglos aplicados y qué debe hacer la sesión de Linux

Detalle completo y verificación en **`cambios-windows.md`**. Resumen:

- **Arreglo 1 (adaptadores virtuales, H1):** `reptile/rust/src/util/net.rs` (`VIRTUAL_PREFIXES`)
  y `reptile/node/src/lib/net.js` (`VIRTUAL_INTERFACE`): añadidos `zerotier`, `virtualbox`,
  `vmware`. No cambia la huella de máquina (usa todas las MACs) ni el protocolo. Pruebas nuevas
  en ambas (Rust `windows_adapter_friendly_names_are_virtual`, Node "Windows adapter friendly
  names ...").
- **Arreglo 2 (divergencia silenciosa, H3):** `commit` quita el atributo de solo lectura y
  reintenta (`mutate.rs`/`mutate.js`, en Windows vía `SetFileAttributesW`); una escritura en vivo
  fallida agenda reconciliación (`syncing.rs`/`syncing.js`), y en Node se revierte el índice y se
  descarta el temporal si `commit` falla. Pruebas nuevas en ambas (`commit_replaces_a_read_only_file`
  / "commit replaces a read-only file (Windows)"). Verificado end-to-end (Rust y Node).
- **Arreglo 3 (probe de descubrimiento, H4; solo Rust):** `peer/probe.rs` — `tcp_check` en Windows
  reescrito con WinSock (connect no bloqueante + `select` + `SO_ERROR`). Test `tests/discovery.rs`
  tolerante al loopback lento de Windows. Clippy limpio.
- **Arreglo 4 (watcher, H5; solo Rust):** `fs/os_watch.rs` — `start` arma el watch de forma síncrona
  (espera a que el hilo lector esté listo), como inotify. El target del watcher pasa 6/6 en paralelo.
- **Arreglo 5 (nombres no representables, H8; regla compartida):** `fs/entry.rs`+`domain/syncing.rs`
  (Rust) y `fs/entry.js`+`domain/syncing.js` (Node): `is_os_representable`/`isOsRepresentable`, usado
  por el predicado de skip. Corta el ciclo de reconciliación y el round-trip del munging. Pruebas en
  ambas.
- **Arreglo 6 (tests POSIX, H6; solo tests):** `cert.test.js`, `lib.test.js`, `paths.test.js` hechos
  conscientes de la plataforma (gated a Windows; Linux intacto).

Resultado: `cargo test` 152/152 y `npm test` 221 OK / 0 fallos / 3 omitidos, en Windows. `cargo
clippy --all-targets` limpio (MSVC). LF sin BOM en todos los archivos tocados.

**Qué debe hacer la sesión de Linux:**
1. Revisar el diff (solo `reptile/rust` y `reptile/node`; LF sin BOM verificado) y
   `cambios-windows.md`.
2. Recompilar en Linux y pasar las suites completas: en Linux deben pasar **todas**
   (`cargo test` ~150+nuevas, `npm test` ~224+nuevas) y `cargo clippy` limpio. Los arreglos
   específicos de Windows van con `#[cfg(windows)]` / `process.platform`, así que no cambian Linux.
3. Reiniciar las instancias de Linux con el código nuevo (arreglos 1 y 5 tocan selección/skip;
   el 2 el motor de sincronización) y, si se quiere, repetir un cruce con **Linux como peer** para
   re-confirmar el arreglo 2 desde ese lado (aquí se verificó con Windows como peer, Rust y Node).
4. Decidir sobre **H7 (rutas largas)** con la propuesta de este informe (único hallazgo de producto
   sin arreglar). **H2 (cortafuegos)** es de documentación (README/instalador o firmar el `.exe`).
5. Repaquetar el `.exe` de Windows (dist) con el código nuevo y hacer el commit.

---

## 7. Qué quedó sin probar y por qué

- **Pasada de navegador de `npm test`** (`browser.test.js`, 3 tests): omitida con
  `REPTILE_SKIP_BROWSER_TESTS=1`; no había Chrome/Chromium disponible para el driver. El panel
  se sirve igual (se accedió a `http://localhost` por API en todas las fases).
- **Rutas largas (H7):** único hallazgo de producto sin arreglar. Se constató que el archivo en una
  ruta >260 car. no se indexa (sin caída); no se implementó el soporte `\\?\` (cambio transversal
  arriesgado para un caso poco común) — queda con propuesta para la sesión de Linux.
- **Re-cruce con el código nuevo en AMBOS lados:** los arreglos se verificaron con Windows como
  peer/host (Rust y Node, unit + end-to-end); el re-cruce con Linux recompilado queda para la sesión
  de Linux (los arreglos de Windows van con `#[cfg(windows)]`/`process.platform`, no cambian Linux).
- **IP de Linux por DHCP:** se mantuvo estable durante toda la prueba (no cambió); no se reservó
  en el router.
