# Prueba de Reptile en Windows 10: lo que debes dejar listo en Linux

Documento temporal (no se commitea). El repo se comparte con Windows por
Syncthing (`D:\Documentos\sync\git\SLOPWARE`), así que **no hay que llevar nada
a Windows**. Tiene dos partes: un **checklist** de cosas
que haces tú en esta máquina Linux, y un **formulario** que la sesión de Claude
Code en Windows leerá para saber IPs, puertos y credenciales. Las instrucciones
para la sesión de Windows están en `instrucciones-prueba-reptile.md`.

Qué se va a probar, en una línea: Reptile 1.1.0 (commit `6e9bcf9`) en Windows 10
real, solo y cruzado por la LAN contra esta máquina, con las dos
implementaciones (Rust y Node.js) en cada extremo.

---

## Parte 1. Checklist (en Linux)

### A. Antes de nada

- [ ] **Confirma la IP de esta máquina.** Cambió durante la sesión: antes era
      `192.168.0.234` y ahora `192.168.0.241` (DHCP). Para la prueba conviene
      que no cambie: reserva la IP en el router, o al menos comprueba que no
      varía mientras dura la prueba. Comprueba la actual con
      `ip -4 -o addr show scope global | grep -v -e docker -e br-`.
- [ ] **La PC Windows está en la misma subred** (misma LAN, no una red de
      invitados con aislamiento entre clientes). Desde Linux:
      `ping -c 2 <IP_WINDOWS>`. Si no responde, puede ser solo el cortafuegos de
      Windows (ICMP bloqueado por defecto); no es concluyente, se comprobará con
      las instancias.
- [ ] **Relojes sincronizados** en ambos equipos (Reptile decide conflictos por
      fecha de modificación). Aquí: `timedatectl | grep synchronized` debe decir
      `yes` (hoy lo dice). En Windows la sesión lo medirá y lo anotará.

### B. Cortafuegos de Linux

- [ ] `sudo ufw status`. Si dice `inactive`, no hay nada que hacer.
- [ ] Si está activo, abre los puertos de prueba **solo para la IP de Windows**
      (sustituye `IP_WINDOWS`):
      ```bash
      sudo ufw allow from IP_WINDOWS to any port 55667:55690 proto tcp
      ```
      Y al terminar la prueba:
      ```bash
      sudo ufw delete allow from IP_WINDOWS to any port 55667:55690 proto tcp
      ```
      Desde esta sesión no puedo ejecutar `sudo` (pide contraseña), así que lo
      haces tú.

### C. Syncthing es el «transporte» (no hay que copiar nada)

El repo está en `D:\Documentos\sync\git\SLOPWARE` en Windows y Syncthing lo
mantiene igual que éste. Solo tienes que **asegurarte de que ha llegado todo**
y de que no estorba:

- [ ] **Los tres archivos de la raíz del repo** (`instrucciones-prueba-reptile.md`,
      `codex-temporal-linux.md` y `reptile-xtest.py`) existen en Windows. El de
      instrucciones se llama ahora **`instrucciones-prueba-reptile.md`**, en
      singular, para que coincida con el prompt que escribirás (me lo habías
      pedido en plural; lo renombré; si lo prefieres en plural, dímelo y cambio
      también el prompt que usas).
- [ ] **El zip de Windows** está en
      `reptile\rust\dist\reptile-1.1.0-windows-x86_64.zip` en Windows. (Si tu
      Syncthing ignora `dist`, mueve una copia, o no pasa nada: la sesión de
      Windows compila el `.exe` por su cuenta.)
- [ ] **Syncthing al día en ambos lados** (estado «Actualizado») **antes** de
      abrir Claude Code en Windows y **antes** de rellenar el formulario si lo
      editas después: la sesión de Windows leerá lo que le haya llegado.
- [ ] **Recomendado, solo si no lo tienes ya:** que `target` (Rust, 1,3 GB) no
      viaje. En el `.stignore` de la carpeta de repos, en **ambos** lados, añade
      `**/target` (y `**/node_modules`, `**/cert`). El `.stignore` es de cada
      dispositivo, no se sincroniza. Si `target` sí se sincroniza, no rompe
      nada (la sesión de Windows compila en otra carpeta), pero puede tardar y
      llenar el disco de Windows.
- [ ] **En Linux, mientras dura la prueba, no compiles ni edites nada dentro del
      repo**, y no me pidas cambios en él: la sesión de Windows va a editar el
      código para arreglar lo que encuentre, y dos escritores a la vez
      producirían conflictos de Syncthing (`*.sync-conflict-*`).
- [ ] **El informe volverá solo**: la sesión de Windows lo escribe en el repo
      (`informe-pruebas-reptile-windows.md` y `resultados-windows\`) y
      Syncthing lo trae aquí. No hay que mover nada a mano.
- [ ] Abre Claude Code en Windows **en la carpeta `D:\Documentos\sync\git\SLOPWARE`**
      y pega, tal cual: `Lee el documento instrucciones-prueba-reptile.md . Ahí encontraras tu nueva tarea.`

### D. Instancias de Reptile en Linux

Las cuatro instancias y un agente de apoyo. Puedes dejarlas en marcha tú con el
bloque de abajo, o decirme «arranca las instancias» y las lanzo yo desde esta
sesión (y las paro al final). **Arrancarlas antes de que la sesión de Windows
empiece**, o esa sesión se quedará esperando.

- [ ] Directorio de trabajo y arranque (ajusta el token si cambiaste el del formulario):
      ```bash
      R=<repo>/reptile
      X=/tmp/reptile-xtest; mkdir -p $X/agent && cd $X
      # Rust y Node, HTTP y HTTPS. --remote-ui deja que la PC Windows maneje sus paneles por la LAN.
      $R/rust/target/release/reptile --port 55667 --remote-ui > rust-http.log 2>&1 &
      # Node escribiría su certificado dentro del repo (sincronizado): lo sacamos de ahí.
      export REPTILE_CERT_DIR=$X/cert-node
      node $R/node/src/index.js      --port 55668 --remote-ui > node-http.log 2>&1 &
      $R/rust/target/release/reptile --port 55669 --remote-ui --https > rust-https.log 2>&1 &
      node $R/node/src/index.js      --port 55670 --remote-ui --https > node-https.log 2>&1 &
      # Agente de apoyo: crea árboles, provoca cambios y verifica dentro de /tmp/reptile-xtest/agent
      python3 <repo>/reptile-xtest.py agent --root $X/agent --port 55690 --token <TOKEN> > agent.log 2>&1 &
      ```
- [ ] **Comprueba que escuchan:** `ss -ltn | grep -E ':556(67|68|69|70|90)'`
      (deben salir 5 puertos).
- [ ] **Comprueba que se alcanzan desde Windows** (la sesión de Windows lo hará
      también, pero conviene verlo tú pronto): desde Windows
      `Invoke-RestMethod http://IP_LINUX:55667/api/ping` debe devolver
      `app: reptile`.

### E. Qué queda expuesto mientras dure (y cómo apagarlo)

`--remote-ui` abre el panel de esas instancias, incluido el PIN, a **cualquier
equipo de la LAN**, y el agente permite escribir en `/tmp/reptile-xtest/agent`
a quien conozca el token. Es aceptable en una LAN doméstica durante la prueba;
no lo dejes encendido después:

- [ ] Al terminar: `pkill -f "release/[r]eptile --port 556"; pkill -f "[r]eptile.*node/src/index.js"; pkill -f "[r]eptile-xtest.py agent"`
      (los patrones con corchetes evitan matar tu propia shell), cerrar el
      cortafuegos (sección B) y `rm -rf /tmp/reptile-xtest`.

### F. Después

- [ ] **Cuando termine la sesión de Windows:** espera a que Syncthing quede al
      día. Entonces yo reviso los cambios (`git status` / `git diff`, más
      `cambios-windows.md`), compruebo que no hay CRLF ni conflictos, recompilo
      aquí, paso las pruebas de las dos implementaciones, reinicio las instancias
      de Linux con el código nuevo, y repito los cruces que lo necesiten. Después
      hago el commit.
- [ ] Cuando la sesión de Windows termine, el informe habrá llegado solo por
      Syncthing a la raíz del repo (`informe-pruebas-reptile-windows.md` y
      `resultados-windows/`). Avísame y lo reviso y actúo sobre lo que encuentre.
- [ ] Los tres archivos temporales de la raíz (`codex-temporal-linux.md`,
      `instrucciones-prueba-reptile.md`, `reptile-xtest.py`) y `resultados-windows/`
      **no se commitean**; cuando termines, bórralos (o muévelos fuera del repo).

---

## Parte 2. Formulario (lo lee la sesión de Windows)

> Rellena **todos** los campos marcados con `←`. Los que ya traen valor son
> mi mejor estimación: verifícalos. La sesión de Windows tomará estos valores
> literalmente.

### Red

| Campo | Valor |
| --- | --- |
| IP de Linux en la LAN ← | `192.168.0.241` |
| Nombre de la máquina Linux | `T14` |
| IP de Windows en la LAN ← | `192.168.0.246` |
| ¿La IP de Linux está reservada/fija en el router? ← | No. |
| ¿Linux tiene `ufw` activo? ← | No. Firewall deshabilitado. |

### Instancias en Linux (arrancadas por la sección D)

| Instancia | Puerto | Directorio de trabajo en Linux |
| --- | --- | --- |
| Rust, HTTP | 55667 | `/tmp/reptile-xtest/agent/<nombre>` |
| Node.js, HTTP | 55668 | ídem |
| Rust, HTTPS | 55669 | ídem |
| Node.js, HTTPS | 55670 | ídem |
| Agente de apoyo (HTTP) | 55690 | raíz `/tmp/reptile-xtest/agent` |

Todas con `--remote-ui` (la sesión de Windows puede llamar a su API:
`http://192.168.0.241:55667/api/state`, etc.). Los nombres de directorio
(`<nombre>`) los elige la sesión de Windows: una palabra de letras, números,
`-` o `_` (por ejemplo `m1-host`).

### Credenciales de prueba

| Campo | Valor |
| --- | --- |
| PIN de todos los hospedajes de prueba | `4242` |
| Token del agente (cabecera `X-Token`) | `xt-9c1cb4bb8475` |

(Si cambias el token en el comando de la sección D, cámbialo aquí también.)

### Versiones en Linux (para el informe)

| Campo | Valor |
| --- | --- |
| Reptile | 1.1.0, commit `6e9bcf9` (rama `master`) |
| Node.js | v24.21.0 |
| Python | 3.10.12 |
| Rust | 1.99.0 (binario `release` ya compilado) |
| Sistema | Linux Mint 21.2, kernel 5.15, glibc 2.35 |
| Reloj | sincronizado por NTP (`timedatectl`: `yes`) |

### Logística

| Campo | Valor |
| --- | --- |
| Carpeta del repo en Windows (y de trabajo) | `D:\Documentos\sync\git\SLOPWARE` (sincronizada por Syncthing) |
| Carpeta temporal en Windows (fuera del repo, no sincronizada) | `D:\reptile-xtest-scratch\` |
| Cómo me devuelve el informe | por Syncthing, en la raíz del repo: `informe-pruebas-reptile-windows.md` y `resultados-windows\` |
| ¿Hay antivirus de terceros en Windows (además de Defender)? ← | No. Sólo Windows Defender |
| ¿Windows está en Windows 10 o 11? ¿qué compilación (`winver`)? ← | Windows 10 |
| Perfil de red de Windows (`Get-NetConnectionProfile`) ← | _(la sesión lo comprobará si lo dejas vacío)_ |

### Límites que le impongo a la sesión de Windows

- **No hace commits ni push, nunca.** Los commits los hago yo desde esta sesión
  cuando vuelva con el informe.
- **Puede arreglar el código de Reptile**, pero solo **después** de terminar las
  pruebas (fase 5 de sus instrucciones), con una prueba automática por arreglo,
  en las dos implementaciones si es una regla compartida, con saltos de línea
  LF (por Syncthing), y anotando todo en `cambios-windows.md`. Los cambios te
  llegan a esta carpeta por Syncthing; **yo no toco el repo mientras ella
  trabaja**, y tú tampoco.
- Puede **instalar o cambiar** lo que necesite *para la prueba* (reglas de
  cortafuegos, directorios temporales, el target de Rust), pero **lo anota y lo
  deshace al terminar**.
- Dentro del repo (que se sincroniza con Linux) solo escribe el informe y
  `resultados-windows\`. Compila con `CARGO_TARGET_DIR` fuera del repo, y todo
  lo temporal (directorios de prueba, certificados de Node) en
  `D:\reptile-xtest-scratch\`.
