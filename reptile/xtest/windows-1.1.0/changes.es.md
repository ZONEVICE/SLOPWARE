# Cambios aplicados durante la prueba en Windows (fase 5)

Sesión de Claude Code en Windows 10 (ATUN). Reptile 1.1.0, commit base `6e9bcf9`.
Reglas seguidas: sin dependencias nuevas, protocolo/JSON del panel idénticos, código y comentarios
en inglés, capa `domain`/`util` correcta, saltos de línea LF sin BOM, una prueba por arreglo que
falla sin él y pasa con él, cambios mínimos. **No se hacen commits** (los hace la sesión de Linux).

Comprobación de LF al final de cada arreglo (ver sección "Verificación LF").

---

## Arreglo 1 — Adaptadores virtuales de Windows no se excluían al elegir la dirección LAN

**Hallazgo (fase 2):** en esta PC `GET /api/state.identity.address` daba `192.168.111.10` (ZeroTier,
VPN virtual) como dirección LAN principal, y el banner mostraba `peers connect 192.168.111.10:55667`,
una IP que un peer de la LAN real no puede alcanzar. `addresses` incluía la de ZeroTier además de la
Wi-Fi real. Rust y Node coincidían (mismo defecto en los dos). vEthernet de Hyper-V (172.23.x) y las
169.254 de Wi-Fi Direct sí se excluían.

**Causa:** el filtro de interfaces virtuales compara por prefijo del nombre. En Linux las interfaces
tienen nombres cortos (`zt*`, `vboxnet*`, `vmnet*`), ya cubiertos. En Windows `GetAdaptersAddresses`
(Rust) y `os.networkInterfaces()` (Node) devuelven el *FriendlyName* del adaptador: "ZeroTier One
[...]", "VMware Network Adapter ...", "VirtualBox Host-Only ...". "ZeroTier One" no empieza por `zt`,
así que no se filtraba. (Hyper-V/WSL "vEthernet (...)" sí, por el prefijo `veth`.)

**Arreglo (regla compartida, en las dos implementaciones):** añadir los *FriendlyName* de Windows a la
lista de prefijos virtuales.
- Rust: `reptile/rust/src/util/net.rs` — `VIRTUAL_PREFIXES`: añadidos `zerotier`, `virtualbox`,
  `vmware` (y comentario del porqué).
- Node: `reptile/node/src/lib/net.js` — `VIRTUAL_INTERFACE`: añadidos `zerotier`, `virtualbox`,
  `vmware` a la alternancia (y comentario).

**No cambia la huella de máquina:** `machine_fingerprint` / `machineFingerprint` usan TODAS las MACs
(no el filtro de nombres), así que `same_directory` y la interoperabilidad Rust↔Node siguen igual
(test `fingerprint_matches_the_node_implementation` y `the machine fingerprint is stable` siguen OK).

**Pruebas añadidas:**
- Rust: `net.rs` test `windows_adapter_friendly_names_are_virtual` (afirma que los FriendlyName son
  virtuales, que `primary_address`/`lan_addresses` eligen la Wi-Fi, y que la huella no cambia).
- Node: `tests/lib.test.js` test "Windows adapter friendly names (ZeroTier, VMware, VirtualBox,
  vEthernet) are not the LAN".

**Verificación:**
- Rust: con el arreglo `cargo test --lib` -> 49 ok. Sin el arreglo, el test nuevo FALLA
  ("assertion failed: is_virtual_name(\"ZeroTier One [...]\")"). Restaurado.
- Node: regex viejo sobre "ZeroTier One [abc]" -> false (fallaría); regex nuevo -> true. El test nuevo
  de `lib.test.js` pasa.

**Nota para la sesión de Linux:** es una regla compartida pero solo afecta a la SELECCIÓN local de
direcciones y al escaneo; no toca el protocolo ni el JSON del panel. No requiere recompilar Linux para
los cruces ya hechos. Conviene recompilar el `.exe` de Windows para que el banner/`address` dejen de
anunciar ZeroTier.

**Verificación end-to-end:** el `.exe` recompilado muestra en el banner `peers connect 192.168.0.246`
(la IP LAN real), no `192.168.111.10` (ZeroTier).

---

## Arreglo 2 — Una escritura remota que no puede reemplazar el archivo destino en Windows causaba divergencia silenciosa

**Hallazgo (fases 3 W4/W5):** cuando el host modificaba un archivo que en el peer (Windows) estaba
BLOQUEADO en exclusiva (W4) o era de SOLO LECTURA (W5), la escritura fallaba y el peer:
(a) no actualizaba el archivo, (b) seguía informando "live: both copies are identical" (falso), (c) no
reintentaba. Un cambio en otro archivo no reparaba el divergente; solo volvía a sincronizarse si ese
mismo archivo cambiaba otra vez en el host. En Linux no pasa: POSIX reemplaza un archivo abierto o de
solo lectura si el directorio es escribible.

**Causa (dos partes):**
1. `Staged::commit` / `commit()` hace `rename(temp, destino)`. En Windows el rename FALLA si el destino
   es de solo lectura o está bloqueado.
2. La aplicación de un op `write` en vivo IGNORABA el resultado de `download`: un fallo no agendaba
   reconciliación, así que la divergencia persistía hasta la reconciliación periódica (5 min) o la
   reconexión. En Node, además, el índice se dejaba apuntando al estado nuevo (sin revertir) y el
   temporal `.reptile-*.tmp` no se descartaba.

**Arreglo (regla compartida, en las dos implementaciones):**
- Solo lectura: en `commit`, si el rename falla y el destino es de solo lectura, quitar el atributo y
  reintentar una vez.
  - Rust: `reptile/rust/src/fs/mutate.rs` — `Staged::commit` + helper `clear_readonly`.
  - Node: `reptile/node/src/fs/mutate.js` — `commit()` + helper `clearReadonly` (import de `chmod`).
- Escritura en vivo fallida: agendar reconciliación cuando `download` devuelve false, y (Node) revertir
  el índice y descartar el temporal si `commit` falla (Rust ya lo hacía).
  - Rust: `reptile/rust/src/domain/syncing.rs` — rama `"write"` de `apply_remote_one`.
  - Node: `reptile/node/src/domain/syncing.js` — rama `case 'write'` de `applyRemoteOne` y manejo de
    `commit` dentro de `download`.

**Pruebas añadidas:**
- Rust: `mutate.rs` test `commit_replaces_a_read_only_file` (`#[cfg(windows)]`). Falla sin el arreglo
  (el rename sobre un archivo de solo lectura da error); pasa con él.
- Node: `tests/mutate.test.js` test "commit replaces a read-only file (Windows)" (skip fuera de win32).

**Verificación:**
- Unit: Rust `cargo test --lib` incluye el test nuevo (ok). Node `tests/mutate.test.js` pasa en win32.
- End-to-end (build recompilado): se repitieron W5 y W4 con peer Rust y con peer Node:
  - W5 (solo lectura): antes NO convergía (30 s); ahora converge en ~1 s y el atributo +R queda limpio.
  - W4 (bloqueado): antes NO convergía (121 s); ahora, al soltar el bloqueo, converge en ~1 s (la
    escritura fallida agenda reconciliación que reintenta).
- La reconciliación agendada tiene reintentos acotados (MAX_RECONCILE_RETRIES), así que un archivo
  permanentemente bloqueado no genera un bucle infinito; converge en cuanto se libera o en la
  reconciliación periódica.

**Nota para la sesión de Linux:** `apply_remote_one`/`applyRemoteOne` y `download` son del motor de
sincronización (comportamiento del PEER). Afecta sobre todo cuando Windows es el peer (ya verificado
aquí). Conviene recompilar/reiniciar las instancias de Linux con el código nuevo y, si se quiere,
repetir un cruce con Linux como peer (en Linux estos fallos no se disparan por el modelo POSIX, pero el
cambio de agendar reconciliación es una mejora de robustez común). No cambia el protocolo ni el JSON.

---

## Arreglo 3 — El probe de descubrimiento clasificaba mal y lento los puertos cerrados en Windows (solo Rust)

**Hallazgo (H4, test `discovery::the_probe_tells_closed_ports...`):** en Windows
`std::net::TcpStream::connect_timeout` a un puerto cerrado devuelve `TimedOut` (no `ConnectionRefused`)
y consume el timeout COMPLETO. `tcp_check` lo clasificaba `Timeout`/`Unreachable` en vez de `Closed`, y
cada puerto cerrado costaba el timeout entero en los sweeps. (El probe de Node no tiene el problema.)

**Arreglo (solo Rust):** `reptile/rust/src/peer/probe.rs` — `tcp_check` partido en dos:
`#[cfg(not(windows))]` el de siempre; `#[cfg(windows)]` uno nuevo con WinSock: socket no bloqueante +
`connect` + `select` sobre los conjuntos de escritura y error + `getsockopt(SO_ERROR)`, que distingue
`WSAECONNREFUSED` (Closed) de un timeout real, respondiendo en cuanto llega el RST. Trampa resuelta:
hay que leer `WSAGetLastError()` INMEDIATAMENTE tras `connect` (cualquier llamada posterior, incluso
liberar memoria, resetea el last-error y ocultaba el `WOULDBLOCK`).

**Prueba:** `reptile/rust/tests/discovery.rs` — el test se hizo tolerante al loopback de Windows (en
Windows, un puerto recién cerrado tarda ~2 s en dar el RST; se mide ~2050 ms): en Windows usa un
connect_timeout de 4 s y una cota de 6 s, en el resto 700 ms / 2 s. Sigue fallando SIN el arreglo
(connect_timeout daría Unreachable aun con más tiempo) y pasa CON él (Closed vía SO_ERROR=10061).

**Nota para Linux:** solo Rust, solo `#[cfg(windows)]`; no afecta a Linux. En esta máquina el loopback
tarda ~2 s en rechazar un puerto recién cerrado (característica del equipo); en una LAN real un puerto
cerrado de un host vivo da RST al instante y ahora se clasifica Closed rápido.

## Arreglo 4 — El watcher de Windows podía perder los cambios hechos justo tras arrancar (solo Rust)

**Hallazgo (H5, flakiness de `tests/watcher.rs`):** con 17 watchers `ReadDirectoryChangesW` en paralelo,
un test del watcher fallaba ~5 de cada 6 veces (uno distinto cada vez; "saw []" = cero eventos).

**Causa:** `OsWatch::start` abría el handle pero el PRIMER `ReadDirectoryChangesW` se emitía dentro del
hilo lector; bajo carga, el hilo tardaba en arrancar y se perdían los cambios tempranos. inotify (Unix)
arma el watch de forma SÍNCRONA en `start`; Windows no tenía esa garantía.

**Arreglo (solo Rust, `#[cfg(windows)]`):** `reptile/rust/src/fs/os_watch.rs` — `start` espera (canal)
a que el hilo lector esté vivo y a punto de emitir el primer `ReadDirectoryChangesW` antes de retornar,
dando a Windows la misma garantía que inotify (una mejora real, no solo del test).

**Prueba/verificación:** `tests/watcher.rs` pasa 6/6 veces en paralelo (antes ~1/6); `cargo test`
completo verde. (Es robustez del watcher; la regresión se ve en que sin el cambio el target falla con
alta probabilidad bajo concurrencia.)

## Arreglo 5 — Ciclo de reconciliación con nombres que el peer no puede representar (regla compartida)

**Hallazgo (H8, observado en M1):** con nombres que Windows no puede crear (`a:b.txt`, `aux.txt`,
`trailing.`…), el peer entraba en un ciclo de reconciliación continuo (`synchronising → live: identical`
cada ~2-3 s) y `trailing.` se convertía en `trailing` (Windows recorta el punto) y hacía round-trip.

**Arreglo (regla compartida):** nueva función que dice si el SO local puede almacenar un wire path
(`is_os_representable` / `isOsRepresentable`: en Windows, falso para segmentos con caracteres reservados,
punto o espacio final, o nombre de dispositivo reservado; en el resto, verdadero), usada por el
predicado de "saltar" de la sincronización, de modo que el planner omite esos nombres (como los no
compartidos) y no reintenta ni deja que el munging haga round-trip.
- Rust: `reptile/rust/src/fs/entry.rs` (`is_os_representable`) + `reptile/rust/src/domain/syncing.rs`
  (`is_rejected`).
- Node: `reptile/node/src/fs/entry.js` (`isOsRepresentable`) + `reptile/node/src/domain/syncing.js`
  (`isRejected`).

**Pruebas:** Rust `entry.rs` `os_representable_names`; Node `lib.test.js` "names the local OS cannot
store…". (En Linux ambas devuelven que todo es representable, así que el comportamiento no cambia allí.)

**Nota:** complementa el filtro de caracteres que `normalizeWirePath` ya tenía (`[\\:*?"<>|]`), añadiendo
los puntos/espacios finales y los nombres de dispositivo reservados.

## Arreglo 6 — Pruebas de `npm test` que asumían POSIX ahora son conscientes de la plataforma (solo tests)

**Hallazgo (H6, 6 fallos de `npm test` en Windows):** son limitaciones de los TESTS en Windows, no del
producto (pasan en Linux). Se hicieron conscientes de la plataforma, SIN cambiar el comportamiento en
Linux (todo gated con `process.platform`):
- `cert.test.js`: la asersión de modo `0o600` de la clave solo se comprueba fuera de Windows (Windows no
  tiene bits POSIX; `fs.chmod` solo alterna solo-lectura). Nota de plataforma: en Windows la clave del
  cert efímero no queda restringida por modo POSIX.
- `lib.test.js` (`resolveWirePath`): usa fixtures con unidad en Windows (`C:\srv\share…`), porque la
  función construye la ruta LOCAL del SO.
- `paths.test.js`: `result.path` se compara sin distinguir mayúsculas en Windows (realpath normaliza el
  casing); los tres tests que dependen de `chmod` POSIX (no-escribible / no-legible) se omiten en Windows
  con un mensaje (el escenario no es reproducible: `chmod` no restringe así en Windows).

---

## Hallazgos NO arreglados (documentados; decisión de la sesión de Linux)

- **H7 — Archivos en rutas > ~260 caracteres no se indexan (MAX_PATH):** en W6, el host creó los
  directorios largos en el peer pero NO indexó el archivo dentro de una ruta de 278 car. (sin caída ni
  bucle). NO arreglado: la corrección correcta es usar rutas extendidas `\\?\` en TODA la capa de acceso
  a archivos (CreateFileW en `fs/entry.rs`, walk, mutate, hashing; y el equivalente en Node), un cambio
  transversal y arriesgado para un caso poco común, que la sesión de Linux no puede validar en Windows.
  Alternativa: manifiesto `longPathAware` + registro `LongPathsEnabled` (cambio de sistema). Dejado como
  decisión.

- **H2 — Cortafuegos de Windows (despliegue, no es código):** al arrancar, Windows crea reglas de BLOQUEO
  silenciosas para `reptile.exe`; sin permitir la app (o firmarla) no se reciben peers por la LAN. Es
  comportamiento de Windows; se documenta para el README/instalador.

---

## Verificación LF (sin CRLF ni BOM) de todos los archivos tocados
Rust: `util/net.rs`, `fs/mutate.rs`, `fs/entry.rs`, `fs/os_watch.rs`, `domain/syncing.rs`,
`peer/probe.rs`, `tests/discovery.rs`.
Node: `src/lib/net.js`, `src/fs/mutate.js`, `src/fs/entry.js`, `src/domain/syncing.js`,
`tests/lib.test.js`, `tests/mutate.test.js`, `tests/cert.test.js`, `tests/paths.test.js`.
-> todos "ok" (LF, sin BOM). `cargo clippy --all-targets` limpio (MSVC).

## Estado de las suites tras los arreglos (Windows)
- `cargo test`: **152 pruebas, 152 OK** (EXIT=0). Antes de esta sesión: 149/151.
- `npm test`: **221 OK, 0 fallan, 3 omitidos** (los 3 de permisos POSIX, gated a Windows) + `browser`
  omitido por no haber Chromium. Antes: 215/221 con 6 fallos.
- (En Linux ambas suites deben seguir pasando completas; lo confirmará la sesión de Linux al recompilar.)
