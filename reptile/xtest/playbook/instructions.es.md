# Tarea: probar Reptile 1.1.0 en Windows 10 real

Eres una sesión de Claude Code que corre en un **Windows 10 con permisos de
administrador**. Otra sesión de Claude Code, en una máquina **Linux** de la
misma red local, escribió este documento. Tu tarea es probar en Windows real
una aplicación que solo se ha probado en Linux y bajo Wine, y devolver un
**informe** con lo que funciona y lo que no.

Habla con el usuario **en español**. El código, los comentarios y los nombres de
archivo que escribas, en inglés. El informe, en español.

---

## 0. Qué es Reptile y qué se quiere saber

Reptile mantiene un directorio idéntico en dos computadoras de la misma LAN, en
tiempo real y en ambos sentidos, por HTTP o HTTPS. Una instancia **hospeda** un
directorio y otra lo **sincroniza**; se manejan desde un panel web local. Tiene
**dos implementaciones compatibles entre sí**:

- **Rust** (`reptile.exe`): lo que se va a empaquetar para Windows. La atención
  principal es esta.
- **Node.js** (`node src/index.js`): la referencia. Debe poder funcionar también
  en Windows y sincronizar con la de Rust.

La versión es **1.1.0**. La parte de Rust para Windows solo se había probado
**bajo Wine en Linux**. No se ha comprobado nunca en Windows real, y estas
son las cosas que Wine no puede validar y que te importan:

1. Que el ejecutable arranque, y qué pasa con el **Cortafuegos de Windows**.
2. **Notificaciones de cambios** (`ReadDirectoryChangesW`) y **file ids** de NTFS
   (así se reconocen los renombrados) sobre un NTFS real.
3. **Interfaces de red** (`GetAdaptersAddresses`): descubrimiento de instancias y
   la «huella de máquina», que debe coincidir entre Rust y Node en la misma PC.
4. **Nombres y rutas de Windows**: caracteres prohibidos, mayúsculas/minúsculas,
   nombres reservados, rutas largas, archivos bloqueados o de solo lectura.
5. **Cierre limpio** con Ctrl+C o cerrando la ventana.
6. **Interoperabilidad por la red real** con instancias Linux, con Rust y con
   Node en cada extremo.
7. Que las **pruebas automáticas** (`cargo test`, `npm test`) pasen en Windows.

---

## 1. Reglas (léelas completas)

- **Puedes arreglar el código de Reptile, pero solo después de la prueba y con
  las condiciones de la fase 5.** Durante las fases 1–4 **no cambies código**:
  prueba, documenta cada fallo (qué hiciste, qué esperabas, qué pasó, evidencia:
  salida, logs, capturas de `GET /api/state`) y sigue. Un código que se mueve
  durante la prueba invalida los resultados y desincroniza a las instancias de
  Linux. Excepción: si un fallo te **impide continuar del todo**, puedes
  arreglarlo en el momento (con las mismas condiciones de la fase 5) y lo
  anotas.
- **No hagas commits ni push, nunca.** Los commits los hace la sesión de Linux
  cuando vuelvas con el informe.
- **Sí puedes** crear, cambiar o instalar lo necesario **para la prueba**:
  reglas de cortafuegos, directorios temporales, el target de Rust, compilar en
  un directorio de salida aparte, etc. **Anota cada cambio de sistema** en el
  informe (sección «Cambios hechos en esta PC») y **deshazlo al final** (fase 7).
- **Dónde se escribe y dónde NO** (lee la sección 2: la carpeta del repo se
  sincroniza sola con Linux por Syncthing). En este documento, `scratch\` es
  `D:\reptile-xtest-scratch\` (fuera del repo, **no sincronizada**) y
  `resultados\` es `D:\Documentos\sync\git\SLOPWARE\resultados-windows\`.
  Todo lo que escribas dentro del repo viaja a Linux, así que dentro del repo
  **solo** escribes el informe y `resultados-windows\`. Fuera del repo (y de
  `%TEMP%`) solo lo que exija la prueba: reglas de cortafuegos, la caché de
  cargo, `scratch\`.
- **No cambies el perfil de red de la PC** (Público/Privado), ni apagues el
  antivirus o Defender: pruébalo tal cual está y anota cómo está.
- No pongas aquí información personal en el informe (nombres de usuario de
  Windows, rutas del perfil de usuario se pueden dejar como `%USERPROFILE%`).
- **Si algo falla, no te detengas**: documéntalo y sigue con lo demás. Solo
  pregunta al usuario si te quedas sin poder continuar (por ejemplo, un dato que
  falta en el formulario, o una instancia de Linux que no responde tras
  comprobarlo).
- Trabaja de forma autónoma pero **avisa al usuario con una línea** al empezar
  cada fase y al terminar con un resumen. No pidas confirmación entre fases.

---

## 2. Dónde estás: el repo ya está aquí, sincronizado por Syncthing

Tu carpeta de trabajo es **el propio repo**: `D:\Documentos\sync\git\SLOPWARE`
(el directorio desde el que arrancó tu sesión). Syncthing la mantiene igual que
la de Linux, en ambos sentidos. No hay nada que copiar ni clonar. En la raíz
del repo deben estar:

| Ruta | Para qué |
| --- | --- |
| `instrucciones-prueba-reptile.md` | este documento |
| `codex-temporal-linux.md` | **el formulario con las IPs, puertos, PIN y token**. Léelo entero ahora: lo que diga ahí manda sobre los ejemplos de este documento. |
| `reptile-xtest.py` | helper de pruebas en Python 3 (sección 3) |
| `reptile\` | Reptile 1.1.0 (`reptile\version.txt` debe decir `1.1.0`), con `rust\`, `node\`, `bench\` |
| `reptile\rust\dist\reptile-1.1.0-windows-x86_64.zip` | el paquete de Windows ya construido (`reptile.exe`, README, licencia). **Si no ha llegado**, avisa al usuario (puede que Syncthing ignore `dist`) y mientras tanto compila tú el `.exe` de la fase 1: sirve igual. |

Comprueba al empezar que **Syncthing ha terminado de sincronizar** esta carpeta
(si ves archivos a medio llegar, o `*.syncthing.*.tmp`, espera un par de
minutos) y que los archivos de arriba existen. Si el zip existe pero pesa distinto
de lo que ves en Linux, no es motivo de parar: anótalo.

**Peligros de que el repo se sincronice con Linux (importante):**

1. **No compiles dentro del repo.** `cargo` escribe su salida en
   `reptile\rust\target\` (más de 1 GB), que se sincronizaría de vuelta a
   Linux, donde ya hay un `target` propio con binarios de Linux: se pisarían.
   Antes de cualquier orden de cargo, en cada consola:
   ```powershell
   $env:CARGO_TARGET_DIR = "D:\reptile-xtest-scratch\target"
   ```
2. **Los certificados de Node.** Node con `--https` escribe su certificado en
   `reptile\node\cert\` (dentro del repo). Define siempre, para toda instancia
   de Node: `$env:REPTILE_CERT_DIR = "D:\reptile-xtest-scratch\cert-node"`.
   (Rust usa `%LOCALAPPDATA%\Reptile\cert`, fuera del repo, y no hay problema.)
3. **Los directorios de prueba** (hospedados y sincronizados) van **siempre** en
   `scratch\`, nunca en el repo: Reptile sincronizando dentro de un directorio
   que además sincroniza Syncthing sería un lío.
4. **No toques `.git` ni cambies archivos del repo.** Si quieres ver la versión,
   `Get-Content reptile\version.txt` y, en Linux, el commit `6e9bcf9`. No uses
   `git status` como diagnóstico: en Windows puede enseñar diferencias por saltos
   de línea o permisos que no significan nada.
5. **Todo lo que escribas en el repo llega a Linux por Syncthing:** el informe
   (`informe-pruebas-reptile-windows.md`) y `resultados-windows\`. Esa es la
   forma de devolverlo; no hay que copiarlo a mano. Si algún log es enorme
   (cientos de MB), déjalo en `scratch\` y cita su ruta.
6. Si Syncthing crea archivos `*.sync-conflict-*` en el repo, **no los borres**:
   anótalos en el informe.

**Comprobación de esta sección:** crea `scratch\` y `resultados-windows\`
(esta última, dentro del repo) y escribe un archivo `resultados-windows\hola.txt`.
Pídele al usuario que confirme que aparece en Linux (o simplemente sigue: el
usuario lo verá en el informe final). Bórralo después.

---

## 3. El helper `reptile-xtest.py`

Es Python estándar (sin dependencias). Lo usas **tú aquí y también el agente
de Linux** (otra copia del mismo archivo corre allí; te deja manejar el lado
Linux por la red). Lee su docstring (`python reptile-xtest.py --help` y las
primeras líneas del archivo). Resumen, con `X = python reptile-xtest.py`:

| Orden | Qué hace |
| --- | --- |
| `X populate DIR [--files 300] [--big-mb 8] [--hostile]` | crea el árbol de prueba (`r1\`, `r2\`) y el resumen de la ronda 0. `--hostile` añade nombres que solo Linux admite (`a:b.txt`, `what?.txt`, `aux.txt`, `Case.txt` + `case.txt`…). |
| `X churn DIR -r 1` | aplica ~45 s de cambios guionizados dentro de `DIR\r1` (crear, modificar, **renombrar** archivo y directorio, mover, borrar archivo y árbol, reemplazar archivo por directorio, archivo de 16 MB, ráfaga de 100) y **al final** escribe `DIR\_xtest-expected-r1.json`. |
| `X converge DIR -r N [--timeout 120] [--tolerate-windows-names]` | espera a que llegue el resumen esperado de la ronda N (lo escribió **el otro lado**) y compara el contenido real, SHA-256 por archivo. Devuelve `ok: true/false`. Con `--tolerate-windows-names`, no cuenta como falta lo que Windows no puede tener (nombres prohibidos, reservados, colisiones de mayúsculas); lo lista en `tolerated`. |
| `X clean DIR` | vacía un directorio. |
| `X api URL MÉTODO RUTA [JSON\|@archivo]` | llama a la API de una instancia de Reptile (evita el infierno de comillas de PowerShell: pon el JSON en un archivo y pasa `@archivo.json`). Los HTTPS autofirmados se aceptan. |
| `X wait URL CLAVE VALOR [--timeout 120]` | espera a que `GET /api/state` tenga, p. ej., `syncing.state` = `live`. |
| `X remote http://IP_LINUX:55690 TOKEN ACCIÓN DIR …` | ejecuta una acción en el **agente de Linux**: `ping`, `populate`, `churn`, `converge`, `digest`, `clean`, `probe --probe-url URL`. Los flags son los mismos. `ping` también mide el desfase de reloj. |

Cómo funciona la verificación: quien provoca los cambios escribe **al final** su
resumen esperado (`_xtest-expected-rN.json`) dentro del propio directorio
sincronizado, así que llega al otro lado **por Reptile mismo**; el otro lado
hace `converge` y compara contenido real. Los archivos `_xtest-*` y los
`.reptile-*.tmp` se ignoran en las comparaciones. **Haz `converge N` justo
después de `churn N` y antes de la ronda siguiente** (el resumen de una ronda
solo es válido en ese momento).

Prueba rápida de que lo tienes bien (con las IPs del formulario):

```powershell
python reptile-xtest.py remote http://IP_LINUX:55690 TOKEN ping
```

debe devolver `platform: linux` y el desfase de reloj. **Anota el desfase**
(`clock_skew_ms_remote_minus_local`): si pasa de ~1 s, avisa en el informe,
porque Reptile decide los conflictos por fecha de modificación.

---

## Fase 0. Reconocimiento del entorno

Anota en el informe, sin cambiar nada:

- `winver`, `[Environment]::OSVersion`, arquitectura, ¿eres administrador? (`net session` o `whoami /groups`).
- `python --version`, `node --version`, `npm --version`, `rustc --version`, `cargo --version`, `rustup show`, `git --version`.
- ¿**Enlazador MSVC** instalado? (`where link.exe` desde una consola normal: puede no salir si solo está en la «Developer Command Prompt»; comprueba también `rustup show` para ver el toolchain por defecto: `stable-x86_64-pc-windows-msvc` o `-gnu`). Si no hay MSVC ni MinGW, `cargo test` fallará al enlazar: anótalo y pasa a la fase 2 (el `.exe` ya empaquetado no lo necesita). **Instalar Visual Studio Build Tools está permitido pero es pesado; no lo hagas sin decírselo antes al usuario.**
- ¿`openssl` disponible? (`openssl version`; Git for Windows trae uno en `C:\Program Files\Git\usr\bin\openssl.exe`). Solo lo necesita **Node con `--https`** (`REPTILE_OPENSSL=<ruta>`). La implementación Rust no lo necesita.
- Antivirus: `Get-MpComputerStatus | Select AMServiceEnabled, RealTimeProtectionEnabled` (y si hay otro de terceros, cuál: el formulario lo dice).
- Red: `Get-NetConnectionProfile`, `ipconfig /all`, `Get-NetAdapter` (¿hay adaptadores virtuales: Hyper-V «vEthernet», WSL, VPN, VirtualBox?), `Get-NetFirewallProfile | Select Name, Enabled`.
- Sistema de archivos del disco de trabajo (`Get-Volume`), ¿NTFS?, y `fsutil 8dot3name query`/`fsutil behavior query disablelastaccess` no hacen falta.
- Alcance de la red: `Test-NetConnection IP_LINUX -Port 55667` (el agente de Linux de la fase 3 y las instancias deben estar arrancadas; si no responde, reintenta unos minutos y avisa al usuario). Después, con el agente:
  `python reptile-xtest.py remote http://IP_LINUX:55690 TOKEN probe --probe-url http://IP_WINDOWS:55667/api/ping` — esto es la prueba inversa (¿llega Linux hasta Windows?). Aún no habrá nada escuchando en Windows: lo importante es distinguir «rechazado» (puerto cerrado pero la máquina responde) de «tiempo agotado» (el cortafuegos descarta).

---

## Fase 1. Compilación y pruebas automáticas en Windows

Directorio `reptile\rust`:

```powershell
$env:CARGO_TARGET_DIR = "D:\reptile-xtest-scratch\target"     # fuera del repo: ver la sección 2
cargo build --release
& "$env:CARGO_TARGET_DIR\release\reptile.exe" --version        # debe imprimir 1.1.0
cargo test 2>&1 | Tee-Object ..\..\..\resultados-windows\cargo-test.txt
```

(Crea `resultados-windows\` en la raíz del repo para los logs.)

- La compilación incrusta el panel desde `..\node\public` y exige que la versión de `Cargo.toml` y `reptile\version.txt` coincidan: ya coinciden (1.1.0).
- Si falta MSVC y quieres insistir: `rustup target add x86_64-pc-windows-gnu` solo sirve si hay un `gcc` de MinGW; si no, **déjalo y anótalo**.
- `cargo test` son **~150 pruebas**. `tests\interop.rs` arranca Node (`node ..\node\src\index.js`) y necesita `node` en el `PATH`; las pruebas HTTPS de Node necesitan `openssl` (si falla por eso, anótalo como «falta openssl», no como fallo de Reptile).
- Cada prueba que falle: **reproduce una vez sola** (`cargo test --test sync nombre -- --nocapture`), clasifica (¿entorno? ¿antivirus que bloquea un archivo recién escrito? ¿ruta/nombre de Windows? ¿fallo real?) y anota la causa probable. **De momento no arregles nada:** los arreglos van en la fase 5, con todos los hallazgos a la vista.
- Node en Windows, directorio `reptile\node`: `$env:REPTILE_SKIP_BROWSER_TESTS=1; npm test 2>&1 | Tee-Object ..\..\..\resultados-windows\npm-test.txt` (sin la pasada de navegador; si hay Chrome/Edge y quieres, lánzala también aparte). Node nunca se ha ejecutado en Windows: **cualquier fallo es informativo**, especialmente los de `watcher.test.js` (en Windows usa un único `fs.watch` recursivo sobre la raíz) y `lib.test.js`.

---

## Fase 2. El ejecutable empaquetado y el Cortafuegos

Usa el `.exe` **del zip** (descomprime `reptile\rust\dist\reptile-1.1.0-windows-x86_64.zip` en `scratch\pkg\`; queda `scratch\pkg\reptile-1.1.0-windows-x86_64\reptile.exe`), no el que compilaste: es el que se distribuirá.

1. `.\reptile.exe --version` → `1.1.0`. `.\reptile.exe --help`.
2. **Antes de crear ninguna regla de cortafuegos**: `Get-NetFirewallRule -DisplayName "*reptile*"` (anota si ya había). Arranca `.\reptile.exe --port 55667 --log-level info` en una consola **visible** y anota qué ve el usuario: ¿aparece el aviso del Cortafuegos de Windows? (como administrador no podrás pulsar el aviso desde aquí; si aparece, díselo al usuario y que lo deje **sin responder** un momento). Sin responder, comprueba si Linux llega: `X remote http://IP_LINUX:55690 TOKEN probe --probe-url http://IP_WINDOWS:55667/api/ping` → anota `status` (200 = llega) o el error.
3. Crea la regla de prueba (anótala para borrarla al final):
   ```powershell
   New-NetFirewallRule -DisplayName "Reptile-xtest" -Direction Inbound -Protocol TCP -LocalPort 55667-55690 -Action Allow -Profile Any
   ```
   Repite el `probe`: ahora debe dar `status: 200` con `app: reptile`.
4. Con la instancia arrancada: abre `http://localhost:55667` y mira la salida de la consola: el banner debe mostrar la IP LAN correcta como «peers connect». Pide `GET /api/state` y copia `identity` (hostname, `address`, `addresses`) al informe. **Comprueba contra `ipconfig`**: ¿`addresses` incluye adaptadores virtuales (vEthernet de Hyper-V/WSL, VirtualBox, VPN)? Reptile salta nombres como `docker*`, `veth*`, `tun*`, `wg*`, pero no los nombres típicos de Windows (`vEthernet (...)`), así que **es muy probable que aparezcan; es un hallazgo a anotar** (no un fallo de la prueba), con la lista exacta.
5. **Cierre limpio**: con un par conectado (hazlo en la fase 4, M1) pulsa **Ctrl+C** en la consola; el otro lado debe pasar a `stopped` (aviso «el host dejó de hospedar») y no a «reconectando». Repite cerrando **la ventana de la consola** con la X (puede no dar tiempo a avisar: anota qué ve el otro lado y en cuánto tiempo).

Una vez hecho, deja de usar el reconocimiento manual: en adelante arranca y para las instancias tú, con los puertos de la tabla siguiente.

### Puertos y comandos de las instancias en Windows

| Instancia | Puerto | Comando (en `scratch\`, cada una en su consola/proceso en segundo plano) |
| --- | --- | --- |
| Rust HTTP | 55667 | `scratch\pkg\...\reptile.exe --port 55667` |
| Node HTTP | 55668 | `$env:REPTILE_CERT_DIR="D:\reptile-xtest-scratch\cert-node"; node reptile\node\src\index.js --port 55668` |
| Rust HTTPS | 55669 | `scratch\pkg\...\reptile.exe --port 55669 --https` |
| Node HTTPS | 55670 | `$env:REPTILE_CERT_DIR="D:\reptile-xtest-scratch\cert-node"; $env:REPTILE_OPENSSL=...; node reptile\node\src\index.js --port 55670 --https` |

(Las de Linux son las mismas, con IP Linux y `--remote-ui`.) Usa `Start-Process`
con redirección de salida a `resultados\*.log` para tener los logs de cada una;
para pararlas, `Stop-Process`. Un proceso por puerto: no reutilices un mismo
puerto sin esperar a que el anterior haya muerto.

---

## Fase 3. Pruebas locales de Windows (sin Linux)

Con dos instancias **en esta misma PC** (hospedaje en una, sincronización en la
otra, por `127.0.0.1`), cubre lo que depende de NTFS. Para cada una anota
resultado y tiempo.

- **W1. Huella de máquina y mismo directorio.** Rust (55667) hospeda `scratch\w1-host`; **Node (55668)** intenta sincronizar a `scratch\w1-host\dentro`. Debe rechazar con `same_directory` (las dos implementaciones calculan la misma huella en la misma PC). Y al revés (Node hospeda, Rust sincroniza). Si no la rechaza, la huella (hostname + MACs) difiere entre Rust y Node en Windows: **hallazgo importante**, con `GET /api/ping` y `GET /api/state` de ambos.
- **W2. Rust ↔ Rust y Rust ↔ Node, local.** Receta de la fase 4, pero por `127.0.0.1` y con `X populate` en el host. Pasar `converge` en rondas 0, 1 y 2 en las cuatro combinaciones (host Rust/peer Rust, host Rust/peer Node, host Node/peer Rust, host Node/peer Node). Si Node falla en Windows, anótalo y sigue.
- **W3. Renombrados en el sitio (file ids).** Durante `churn` del host, el archivo `r1\docs\spaces in name.txt` se renombra a `r1\docs\renamed ñ.txt`. En el peer (Windows), anota antes `fsutil file queryfileid "…\r1\docs\spaces in name.txt"` y después la del nombre nuevo: si el ID es **el mismo**, se renombró en el sitio (no se transfirió de nuevo). Igual con el directorio `project` → `project-renamed`.
- **W4. Archivo bloqueado.** En el peer, abre un archivo con acceso exclusivo mientras el host lo modifica:
  ```powershell
  $f = [IO.File]::Open("…\r1\docs\readme.txt",'Open','ReadWrite','None')   # bloqueado
  # …modifica ese archivo en el host…; espera ~10 s; luego:
  $f.Close()
  ```
  Reptile no debe caerse; después de soltarlo, debe converger (puede tardar unos segundos por los reintentos). Anota cuánto, y qué ve el panel (`syncing.activity`, `GET /api/state`).
- **W5. Solo lectura.** `attrib +R` en un archivo del peer y modifícalo desde el host. Debe actualizarse, o fallar sin caída y reintentar; anota.
- **W6. Nombres y rutas.** Con `--hostile` (en una receta con host Linux, fase 4, M1). Aquí, con Windows como host: crea a mano `scratch\w6-host\Mayús.txt`, un archivo con nombre de 200 caracteres, un directorio con ruta total >260 caracteres (`\\?\` si hace falta para crearlo) y `con.txt`/`aux.txt` mediante `\\?\` (Windows normal no deja crearlos). Qué hace Reptile con cada uno (se sincroniza, se omite, o se cae). Una caída o un bucle son **fallos graves**.
- **W7. Rutas con barras.** Pide una sincronización con `localPath` escrita con `/` (`D:/reptile-xtest-scratch/w7`) y con `\\` en el JSON: ambas deben aceptarse, o rechazarse con un mensaje claro. Anota.
- **W8. Rendimiento con Defender activo.** `X populate scratch\w8-host --files 5000 --big-mb 16` y sincroniza local Rust↔Rust: tiempo hasta `converge -r 0`. Es solo una referencia (en Linux, 20 000 archivos tardan ~2 s).

---

## Fase 4. Pruebas cruzadas Windows ↔ Linux por la LAN

Esta es la fase central. El lado Linux se maneja **por red**: sus instancias
(`--remote-ui`) por su API en `http://IP_LINUX:PUERTO`, y su sistema de archivos
con el agente en `http://IP_LINUX:55690`. Usa `$AG = "http://IP_LINUX:55690"` y
el token del formulario. La carpeta de Linux de cada escenario es
`/tmp/reptile-xtest/agent/<N>` (el agente la crea).

### La receta (con rondas)

Variables: `N` = nombre del escenario (por ejemplo `m1`). `L` = URL de la
instancia Linux, `W` = URL de la de Windows (`http://127.0.0.1:PUERTO`).
`DIR_W` = `D:\reptile-xtest-scratch\<N>` (Windows), `DIR_L` = `/tmp/reptile-xtest/agent/<N>`.
Los JSON van en archivos (`@body.json`).

**Si el host es Linux** (peer = Windows):

1. `X remote $AG TOKEN clean N` y `X remote $AG TOKEN populate N --files 300 --big-mb 8` (añade `--hostile` solo en M1).
2. `X clean DIR_W`.
3. `X api L POST /api/host @host.json` con `{"path":"DIR_L","name":"N","pin":"4242"}`. Debe devolver 201.
4. `X api W POST /api/sync @sync.json` con `{"address":"IP_LINUX","port":PUERTO_L,"localPath":"DIR_W con \\ escapadas","pin":"4242"}`. 201.
5. `X wait W syncing.state live --timeout 180`; `X converge DIR_W -r 0 --timeout 180` (con `--tolerate-windows-names` si hay `--hostile`). **Esto prueba la sincronización inicial.** Anota segundos.
6. **Cambios del lado host (Linux):** `X remote $AG TOKEN churn N -r 1` (bloquea ~45 s). Luego `X converge DIR_W -r 1 --timeout 120`. (Aquí mide W3.)
7. **Cambios del lado peer (Windows):** `X churn DIR_W -r 2` (~45 s). Luego `X remote $AG TOKEN converge N -r 2 --timeout 120`.
8. Para: `X api W DELETE /api/sync`; `X api L DELETE /api/host`. Comprueba con `GET /api/state` de ambos que quedaron en `idle`.

**Si el host es Windows** (peer = Linux):

1. `X clean DIR_W`; `X populate DIR_W --files 300 --big-mb 8`; `X remote $AG TOKEN clean N`.
2. `X api W POST /api/host @host.json` con `{"path":"DIR_W","name":"N","pin":"4242"}`.
3. `X api L POST /api/sync @sync.json` con `{"address":"IP_WINDOWS","port":PUERTO_W,"localPath":"DIR_L","pin":"4242"}`.
4. `X wait L syncing.state live`; `X remote $AG TOKEN converge N -r 0 --timeout 180`.
5. **Host (Windows) cambia:** `X churn DIR_W -r 1`; `X remote $AG TOKEN converge N -r 1 --timeout 120`.
6. **Peer (Linux) cambia:** `X remote $AG TOKEN churn N -r 2`; `X converge DIR_W -r 2 --timeout 120`.
7. Para: DELETE de ambos lados.

Aprovecha **cada** escenario para mirar `GET /api/state` en ambos lados y
guardar un `identity` + `syncing` (o `hosting`) de ejemplo en `resultados\`. Si
algo no converge, **antes de repetir** guarda: `GET /api/state` de los dos,
`X digest` de las dos carpetas, los logs de las instancias, y el resultado
completo de `converge` (que lista `missing`, `extra` y `changed`).

### Escenarios

| Id | Host | Peer | Protocolo | Notas |
| --- | --- | --- | --- | --- |
| **M1** | Linux Rust (55667) | Windows Rust (55667) | HTTP | con `--hostile`; mide W3; aquí haz la prueba de **Ctrl+C** (fase 2.5) al final |
| **M2** | Windows Rust (55667) | Linux Rust (55667) | HTTP | |
| **M3** | Linux Node (55668) | Windows Rust (55667) | HTTP | |
| **M4** | Windows Rust (55667) | Linux Node (55668) | HTTP | |
| **M5** | Linux Rust (55667) | Windows **Node** (55668) | HTTP | si Node no funciona en Windows, anótalo |
| **M6** | Windows **Node** (55668) | Linux Rust (55667) | HTTP | ídem |
| **M7** | Linux Rust (55669) ⇄ Windows Rust (55669) | ambos sentidos | **HTTPS** | primero host Linux, luego host Windows |
| **M8** | Linux Node (55670) → Windows Rust (55669); y Windows Rust (55669) → Linux Node (55670) | | **HTTPS** | prueba que cada una acepta el certificado autofirmado de la otra |
| **M9** | cambio de PIN | | HTTP | host Linux Rust, peer Windows Rust, ya `live`: `X api L POST /api/host/pin @pin7777.json` (cuerpo `{"pin":"7777"}`); el peer debe pasar a `pin_required` casi al instante; con un PIN erróneo `X api W POST /api/sync/pin @pin1111.json` → 403; con `7777` → vuelve a `live` y converge (haz un cambio a cada lado durante la pausa y comprueba que se intercambian) |
| **M10** | caída brusca | | HTTP | host Linux Rust, peer Windows Rust, `live`: `Stop-Process -Force` al peer de Windows y mide cuánto tarda el host en liberar la sesión (`GET /api/state` → `hosting.session` pasa a `null`, esperado ~20 s). Arranca el peer otra vez y sincroniza de nuevo sin errores. Luego **al revés**: mata (`Stop-Process -Force`) un host de Windows con un peer Linux conectado; el peer debe pasar a `reconnecting` y, al volver a hospedar, reconectar. |
| **M11** | descubrimiento | | HTTP | con las instancias de ambos lados **inactivas** (sin hospedar) y el escaneo activado: `GET /api/state` en la de Windows (Rust, 55667) → `discovery.instances` debe listar las 4 de Linux en ≤ 20 s (campos `address`, `port`, `protocol`, `compatible`); en las de HTTP `compatible: true`, en las HTTPS `false`. Y desde las de Linux hacia Windows: `X api http://IP_LINUX:55667 GET /api/state` → `discovery.instances` debe incluir las de Windows. Pon la de Windows a hospedar y comprueba que el estado `hosting` se ve del otro lado. |
| **M12** | rendimiento | | HTTP | `populate` de **5000 archivos** y `big-mb 64`, host Linux Rust → peer Windows Rust, y al revés: tiempo del `converge -r 0` en ambos sentidos. |

Para cada escenario anota: ✅/❌/⚠️, **tiempos** (inicial, `churn` 1 y 2),
`tolerated` (si hay), anomalías.

### Qué cuenta como esperado y qué no

- **Esperado, no es fallo:**
  - Que en M1 (`--hostile`) falten en Windows los archivos con nombres que
    Windows no admite, y que `converge --tolerate-windows-names` los liste en
    `tolerated`. El sistema **no debe caerse** ni quedarse reintentando sin fin.
    Anota si queda algún ciclo de reconciliación en el log.
  - Que una de las dos variantes `Case.txt` / `case.txt` gane en Windows.
  - Transiciones de estado `syncing` ↔ `live` breves.
- **Fallo:** cualquier `ok: false` en `converge` que no sea nombre incompatible
  con Windows; una instancia que se cuelga o se cierra sola; errores `500` o
  `internal` en la API; mensajes de «reconectando» que no acaban; archivos `.reptile-*.tmp` que
  se quedan; archivos corruptos (hash distinto); un renombrado que se hace como
  borrar+copiar (para file ids, solo en Windows como peer).
- **Dudoso**: anótalo, con evidencia y una hipótesis.

---

## Fase 5. Arreglos y nueva verificación

Con **todos** los hallazgos de las fases 1–4 a la vista, arregla los que sean
fallos reales de Reptile (no los del entorno, ni lo «esperado», ni lo que sea
una decisión de diseño: esos van al informe y los decide el usuario). Aquí sí
puedes editar `reptile\rust` y `reptile\node`, con estas condiciones:

1. **Antes de tocar nada, lee** `reptile\CLAUDE.md` (reglas comunes y contrato
   del protocolo) y la guía de la implementación que vayas a tocar
   (`reptile\rust\CLAUDE.md` o `reptile\node\CLAUDE.md`). Se cumplen siempre:
   sin dependencias nuevas, el protocolo y el JSON del panel **idénticos** en
   las dos implementaciones, código y comentarios **en inglés**, comentarios que
   explican el *porqué*, y la capa correcta (las reglas, en `domain`).
2. **Una regla compartida se arregla en las dos implementaciones** (Rust y
   Node), con su prueba en cada una. Si algo es propio de una sola (por
   ejemplo, `ReadDirectoryChangesW` en Rust), solo en esa. Si no puedes
   arreglar una de las dos, no dejes una a medias: déjalo documentado.
3. **Cada arreglo lleva una prueba automática que falle sin él y pase con él.**
   Compruébalo de verdad (quita el arreglo, mira que falle, restáuralo). Las
   que solo tengan sentido en Windows, con `#[cfg(windows)]` (Rust) o
   `process.platform === 'win32'` (Node).
4. **Cambios mínimos**: nada de refactors, formato masivo ni «mejoras» de paso.
5. **Saltos de línea LF y sin BOM** en todo archivo que toques. Esto es crítico:
   el repo se sincroniza con Linux y un archivo convertido a CRLF aparecería allí
   como cambiado en todas sus líneas. Tras editar, comprueba cada archivo
   modificado, por ejemplo:
   ```powershell
   python -c "import sys; [print(f, 'CRLF!' if b'\r\n' in open(f,'rb').read() else 'ok') for f in sys.argv[1:]]" reptile\rust\src\util\net.rs reptile\node\src\lib\net.js
   ```
   Si tu editor o herramienta escribe CRLF, convierte antes de seguir.
6. **Lleva un registro en `cambios-windows.md`** (raíz del repo): por cada
   arreglo, los archivos tocados, el hallazgo que resuelve, la prueba nueva y
   cómo la verificaste. Es lo que la sesión de Linux revisará.
7. **Después de arreglar:** `cargo test` completo y `npm test` completos (tienen
   que seguir pasando **todos**, además de los nuevos), y repite el escenario
   que falló. Con el código de Windows ya cambiado, las instancias de Linux
   siguen corriendo con **el código anterior**: si el arreglo afecta a algo que
   necesita ambos lados (protocolo, sincronización cruzada), dilo en el informe
   para que la sesión de Linux recompile y reinicie sus instancias y se repita
   el cruce; lo que sí puedes comprobar tú solo (todo lo local y lo que solo
   depende del lado Windows) hazlo.
8. **Candidato ya identificado** (si lo confirmas en la fase 2): los nombres de
   adaptadores virtuales de Windows (`vEthernet (…)` de Hyper-V/WSL,
   `VirtualBox Host-Only`, `VMware Network Adapter`, `Loopback`, etc.) no están en
   la lista que Reptile ignora al elegir las direcciones LAN y escanear. La
   lista está en `reptile\node\src\lib\net.js` (`VIRTUAL_INTERFACE`) y en
   `reptile\rust\src\util\net.rs` (`VIRTUAL_PREFIXES`); se amplía en las dos,
   con prueba (`lib.test.js` y los tests unitarios de `net.rs`).

Si un arreglo exige una decisión de diseño (cambiar el protocolo, o el
comportamiento visible), **no lo hagas**: descríbelo en el informe con las
opciones.

---

## Fase 6. El informe

Escribe **`informe-pruebas-reptile-windows.md`** en la carpeta de trabajo (en
español), con estas secciones, en este orden:

1. **Resumen** (5–10 líneas): ¿Reptile 1.1.0 está listo para Windows? ¿qué falla?
2. **Entorno**: lo de la fase 0 (Windows, versiones, antivirus, adaptadores, cortafuegos, MSVC/GNU, openssl).
3. **Tabla de resultados**: una fila por prueba (fase 1: `cargo test`, `npm test`; fase 2; W1–W8; M1–M12) con resultado, tiempos y una frase.
4. **Hallazgos**: uno por apartado, numerados, cada uno con **qué hiciste, qué esperabas, qué pasó, evidencia** (comandos, salida, fragmentos de log o de `GET /api/state`), **gravedad** (bloqueante / importante / menor / informativo), **causa**, y **si lo arreglaste** (qué archivos, qué prueba, ver `cambios-windows.md`) o, si no, por qué no y qué propones.
5. **Cambios hechos en esta PC**: cada regla de cortafuegos, instalación, directorio, proceso, variable de entorno que creaste, y si lo deshiciste.
6. **Arreglos aplicados** (resumen de `cambios-windows.md`) y **qué debe hacer la sesión de Linux** (revisar el diff, recompilar, reiniciar instancias, repetir cruces, y hacer el commit).
7. **Qué quedó sin probar y por qué.**

Guarda los datos en bruto en `resultados\`: `cargo-test.txt`, `npm-test.txt`,
logs de cada instancia, un `state-*.json` por escenario, y los JSON de
`converge`. El informe cita estos archivos.

---

## Fase 7. Limpieza (obligatoria)

1. Para todas las instancias de Reptile y cualquier proceso `python`/`node` que hayas dejado (`Get-Process reptile, node, python -ErrorAction SilentlyContinue`; cuidado de no matar la sesión que te ejecuta a ti: **filtra por ruta o por línea de comandos**, no por nombre solo).
2. `Remove-NetFirewallRule -DisplayName "Reptile-xtest"` y verifica con `Get-NetFirewallRule -DisplayName "Reptile-xtest"` (debe dar error de «no encontrado»). Revisa también si Windows creó él mismo reglas para `reptile.exe` (`Get-NetFirewallApplicationFilter | ? Program -like "*reptile*"`); si el aviso del cortafuegos las creó, **anótalas en el informe** y bórralas.
3. Borra `scratch\` (los directorios de prueba) y quita las variables `CARGO_TARGET_DIR` y `REPTILE_CERT_DIR` de tus consolas si las dejaste; **conserva** `resultados\` y el informe.
4. No toques nada del repo salvo lo tuyo: el informe y `resultados-windows\`. Borra también `D:\reptile-xtest-scratch\` (incluida la caché de compilación `target`, que es grande), pero conserva el informe y `resultados-windows\`.

Termina diciendo al usuario, en una línea, dónde está el informe y cuántas
pruebas pasaron/fallaron/quedaron dudosas.

---

## Apéndice: ayuda rápida

- **PowerShell y JSON:** crea el cuerpo con una here-string y pásalo por archivo:
  ```powershell
  @'
  {"path":"D:\\reptile-xtest-scratch\\m2","name":"m2","pin":"4242"}
  '@ | Set-Content -Encoding utf8 body.json
  python reptile-xtest.py api http://127.0.0.1:55667 POST /api/host "@body.json"
  ```
- **Estado de una instancia:** `python reptile-xtest.py api http://127.0.0.1:55667 GET /api/state`.
- **Estados de sincronización:** `connecting`, `syncing`, `live`, `reconnecting`, `pin_required`, y terminales `stopped` (el host paró) y `error` (el directorio local desapareció).
- **Códigos de error útiles** (cuerpo `{"error":{"code","message"}}`): `pin_invalid` 403, `busy` 409, `protocol_mismatch` 400, `same_directory` 400, `not_hosting` 409, `unauthorized` 401, `conflict` 409.
- **Rutas de la API** (las dos implementaciones): `/api/state`, `/api/ping`, `/api/host`, `/api/host/pin`, `/api/sync`, `/api/sync/pin`, `/api/sync/inspect`, `/api/discovery`, `/api/discovery/scan`. El resto del contrato está en `reptile\CLAUDE.md` (sección 4), y la guía de la implementación Rust en `reptile\rust\CLAUDE.md`. **Léelos solo si lo necesitas**; no hace falta para ejecutar este plan.
- Si el agente de Linux no responde: dile al usuario (no puedes arrancarlo tú).
- Si una instancia dice «puerto en uso» o salta a otro puerto: hay un proceso viejo; búscalo y párelo. Las pruebas esperan los puertos de la tabla.
