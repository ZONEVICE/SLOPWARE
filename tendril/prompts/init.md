The live maintenance guide for this application is [`../CLAUDE.md`](../CLAUDE.md). This file only keeps the developer's prompts, as history: it is not a specification to re-execute.

Prompt used to create this application (the section between the "RECOMENDACIÓN DE IA (CLAUDE)" markers was drafted by Claude as technical advice and reviewed by the developer, whose own comments inside it are marked "Comentario humano"; everything else is the developer's):

````
Crea el directorio `tendril`, vas a crear una aplicación web ahí.

# Detalles Técnicos

El host actual tiene NodeJS, Python y Rust para que lo uses en lo que necesites. La sesión estará en Linux Mint y posteriormente en Windows 10 para realizar pruebas y ajustes entre cada ambiente en que se ejecute la aplicación. En esta primera sesión, deja todo lo posible preparado para la posterior prueba y desarrollo en Windows usando Wine, que está disponible.

La aplicación debe estar creada completamente en Rust del lado del servidor. Del lado de la GUI debe estar todo programado completamente en HTML/CSS/JS embebido dentro de la aplicación Rust.

Eres libre de usar las librerias que quieras si esto asegura estabilidad en la funcionalidad a resolver, de lo contrario, escribir el código a mano. Utiliza las librerias: CodeMirror 6, Monaco Editor y rcgen.

La aplicación debe ser posible ejecutarla únicamente con un `.exe`/`.sh`. Sin otros ficheros requeridos. Unico ejecutable embebido.

Por defecto, el puerto web debe ser 6060. La app debe estar preparada para funcionar en `0.0.0.0` para asegurar que la app funcione si se accede por VPN, red local o red de Internet abierto.

Por defecto la app se abre en HTTPS. Cada vez que la app se ejecute, exista ya o no, se debe generar un certificado autofirmado con la libreria `rcgen` y utilizarla. Al iniciar la app, se puede hacer por medio de, por ejemplo: `./tendril http` para iniciar la app sin HTTPS. El certificado debe guardarse en el directorio de persistencia en `.tendril/cert` (lectura de persistencia de datos más adelante).

Se debe implementar una seguridad bastante fuerte y estricta para evitar conexiones no deseadas y acceder a rutas sin permiso. Se puede establecer una contraseña al ejecutar la aplicación como `tendril --password <contraseña>`. De no especificar contraseña, se establece siempre una contraseña aleatoria de 8 caracteres conformado por letras y numeros que se muestra una unica vez en la consola. La contraseña se puede establecer siempre en el fichero `./tendril/settings.json` (lectura de persistencia de datos más adelante).

Todos los graficos e iconos debes crearlos tu mismo en SVG o código JavaScript/CSS según corresponda.

La aplicación debe tener diferentes temas. Se carga el tema del sistema para elegir si establecer el tema claro o oscuro según corresponda. El tema se guarda en LocalStorage para recordar la elección la próxima vez. Los temas se desglosan a continuación:

- Dark: Tema oscuro.
- Light: Tema claro.
- Kirby: Tema con paleta de rosas.
- Gorbino: Tema inspirado en el video juego Cruelty Squad. Revisa en Internet imagenes del juego para inspirarte en el estilo y replicarlo.
- Dark OLED: tema de negros y blancos absolutos donde predomina el negro.
- Dos: Tema azul clasico de SHELL antigua.
- Nuclear: Tema verde de terminales antiguas.
- Ambar: Tema naranja de terminales antiguas.
- Eye Burned: Tema donde predomina el blanco absoluto.

La aplicación debe estar optimizada lo mejor posible para que utilize la menor cantidad de RAM posible en el host que ejecuta el binario.

La aplicación debe estar diseñada también para que pueda ser utilizada con relativa comodidad en un dispositivo móvil (pantalla pequeña).

Utiliza herramientas o la estrategía que consideres razonable para "ver" como va quedando graficamente la aplicación. Por ejemplo, ejecutando Chromium Headless, tomando un screenshoot y 'mirando' la imagen para determinar si el estilo es correcto o está tosco.

# Funcionalidades

La aplicación es un editor web de código sumamente ligero.

Utiliza CodeMirror 6 o Monaco Editor para la edición de código. El usuario puede escoger el editor de preferencia.

Toda la GUI debe ser mínima y limpia, pero con toda las funcionalidades integradas de un editor de código moderno.

## Al ingresar a la aplicación web

Cuando un usuario ingresa a la aplicación, si este no tiene token/cookie que verifique que ha iniciado sesión, se debe directamente preguntar la contraseña al cliente. No puede realizar ninguna acción hasta que coloque la contraseña establecida al ejecutar el proceso de la aplicación.

Si el usuario ingresa la contraseña de forma incorrecta 3 veces, la conexión de ese usuario queda bloqueada y no puede intentar ingresar la contraseña nuevamente. Para "desbloquear" al usuario, se debe detener el proceso completo de la aplicación y volver a ejecutar para eliminar esa "lista negra" generada.

Cuando el usuario ingresa la contraseña correctamente, se le presenta al usuario un formulario sencillo para elegir el directorio que se desea editar. La aplicación puede leer el árbol de directorios completo comenzando desde la raíz del host y se lo presenta al cliente para seleccionar un directorio como workspace. Al seleccionar un workspace, no se crea ningun fichero residual ahí y se muestra entonces el directorio en la GUI con el editor de código mostrado y el árbol de objetos a la izquierda, barra de herramientas arriba. Como cualquier editor de código moderno. Por defecto se muestra el editor de código CodeMirror6, pero se puede cambiar en cualquier momento en la barra de herramientas superior en la opción y dropdown correspondiente.

## Uso del Editor de Código

Se pueden encontrar herramientas tipicas de un editor de código.

Word wrap, toggle mini-map si esta disponible, colorear el código (nativo de las librerias de editor de código).

El arbol de objetos permite crear ficheros, directorios, duplicar, copiar, pegar, eliminar, mover. Agrega todo lo necesario y que consideres propio e interesante para utilizar.

Debe haber un visor automatico de imagenes, videos, audio y PDF en caso de que se abra un fichero de este tipo.

Debe haber una terminal integrada que se abre desde un panel inferior al estilo Visual Studio Code.

## Estilo

Como mencioné, el estilo debe ser sumamente mínimo y limpio.

Se espera tener caracteristicas como:

- Arbol de objetos a la izquierda y se puede mover a la derecha.
- Editor de código en el centro.
- Terminal integrada por defecto cerrada abajo.
- Barra de tabs que muestra el fichero de código abierto (o imagen, video, audio, PDF) que muestra un icono de si se cambió el contenido y no se ha guardado.
- Barra de herramientas superior con iconos diminutos hechos en SVG que al colocar el mouse encima muestra en un tooltip qué hace el botón.
- Barra de herramientas estilo clasico y moderno de "File", "Edit", "Selection", "Find", "Tools", "Preferences", etc. Que al dar clic se muestra un dropdown con otras herramientas.
- Hay algunas ventanas especificas que por comodidad se abre en el espacio completo donde se ubica el editor de código y se cierra como un tab. Por ejemplo la ventana de ajustes de la aplicación.

## Persistencia de datos

La aplicación guarda todos aquellos datos de persistencia en el directorio `.tendril/`.

Este directorio se genera en el directorio del usuario que ejecutó el proceso. En Linux: `/home/usuario/.tendril`. En Windows: `c:/Users/usuario/.tendril`.

Todos los ficheros de persistencia se deben guardar como JSON.

## Logs del sistema

Todos los datos de uso, errores del sistema o cualquier otro dato que consideres relevante para futuros desarrollos, bug fixes y revisiones de auditoria se deben guardar como JSON en el directorio `.tendril/logs/` de persistencia de datos.

## Timeout y auto-cerrado

Dado que es una aplicación peligrosa si se deja ejecutando sin supervición o IDLE.

Integra un sistema que al detectar que la aplicación ha estado inactiva por cierto tiempo, la misma se cierra por si misma.

Por defecto, después de 3 horas de inactividad, la aplicación se cierra. Ese rango es completamente parametrizable en el teorico fichero `.tendril/settings.json` el cual es editable en el menú Settings de la aplicación.

No se puede desactivar esta funcionalidad. Virtualmente se puede desactivar colocando un tiempo lo suficientemente alto como para que nunca se cierre la aplicación. Eso es permitido y se asume que el usuario está asumiendo el riesgo que esto presenta.

En los ajustes, hay también un botón para terminar el proceso. Obviamente pide confirmación antes de cerrar.

<!-- ============================================================== -->
<!-- INICIO DE LA SECCIÓN DE RECOMENDACIÓN DE IA (CLAUDE)            -->
<!-- ============================================================== -->

# Recomendaciones Técnicas — Sección de recomendación de IA (Claude)

> **AVISO DE AUTORÍA:** Esta sección completa, desde el marcador "INICIO DE LA SECCIÓN DE RECOMENDACIÓN DE IA (CLAUDE)" hasta el marcador "FIN DE LA SECCIÓN DE RECOMENDACIÓN DE IA (CLAUDE)", fue redactada por la IA Claude (Anthropic) como recomendación técnica. **Todo el resto de este documento, antes y después de esta sección, es prompt 100% humano.**
>
> **Regla de prioridad:** si algo de esta sección contradice al prompt humano, **el prompt humano siempre gana**. Esta sección solo detalla *cómo* implementar lo que el prompt humano pide.

## Objetivo prioritario

El consumo mínimo de RAM y CPU es el requisito técnico más importante. La app debe funcionar con holgura en una Raspberry Pi o una VM de 1 GB de RAM. Ante cualquier decisión de diseño, elige la opción más ligera aunque sea menos elegante. Lo que el prompt humano exige y es pesado (por ejemplo Monaco o la terminal) no se elimina: se carga de forma diferida, solo cuando el usuario lo usa, y se libera cuando deja de usarse.

## Backend (Rust)

- `axum` como servidor HTTP y WebSocket.
- `tokio` con el runtime `current_thread` (no multi-thread), para reducir memoria e hilos. Las operaciones bloqueantes (lectura del PTY, IO pesada) van en `spawn_blocking` o en un hilo dedicado.
- `rust-embed` para incrustar todo el frontend dentro del binario. Incrusta los assets ya comprimidos (gzip generado en el paso de build) y sírvelos con `Content-Encoding: gzip` cuando el navegador lo acepte, para no descomprimir en el servidor.
- `rcgen` para el certificado autofirmado y `rustls` (vía `tokio-rustls` o `axum-server` con `tls-rustls`) para servir HTTPS. Usa el proveedor criptográfico `ring` en lugar de `aws-lc-rs`, porque este último requiere CMake/NASM y complica la compilación en Windows y en musl.
- `serde` y `serde_json` para la API, los ajustes y los logs.
- `mime_guess` para servir los archivos con el tipo correcto.
- `subtle` para comparar la contraseña y los tokens de sesión en tiempo constante.
- `getrandom` (o `rand` con CSPRNG) para la contraseña aleatoria y los tokens de sesión.
- `portable-pty` para la terminal.
- Argumentos de línea de comandos parseados a mano con `std::env::args` (sin `clap` ni similares): subcomando `http`, opción `--password <contraseña>` y, opcionalmente, `--port <n>` y `--bind <ip>`. Por defecto: HTTPS, puerto 6060, `0.0.0.0`.
- El directorio del usuario se obtiene de las variables `HOME` (Linux) y `USERPROFILE` (Windows), sin crates adicionales.
- No añadas crates que no sean estrictamente necesarios. Justifica cada dependencia con un comentario en `Cargo.toml` (Comentario humano: y en CLAUDE.md).

## Compilación y distribución

- En `Cargo.toml`, perfil release con: `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`.
- Como `panic = "abort"` no ejecuta destructores, instala un panic hook que escriba el error en el log de forma síncrona antes de abortar.
- Linux: compila contra `musl` (`x86_64-unknown-linux-musl`, y `aarch64-unknown-linux-musl` para Raspberry Pi) para obtener binarios estáticos portables. En Linux el entregable es el binario nativo; no debe necesitar ningún script ni archivo adicional para ejecutarse.
- Windows 10: compila para `x86_64-pc-windows-msvc` con CRT estático (`-C target-feature=+crt-static` en `.cargo/config.toml`) para obtener un `.exe` único sin DLLs extra. musl no aplica a Windows.
- Incluye scripts de build (`build.sh` y `build.ps1`) que primero generan el bundle del frontend con esbuild y luego compilan Rust. Estos scripts son solo para compilar, no para ejecutar la app.
- Al terminar: `cargo clippy` sin advertencias, compila en release y reporta el tamaño del binario y el consumo de RAM en reposo (RSS) tras arrancar, en Linux y en Windows.

## Frontend

- Sin frameworks (nada de React, Vue, etc.). HTML, CSS y JavaScript vanilla con módulos ES.
- `esbuild` solo como herramienta de compilación (dependencia de desarrollo), con `--bundle --minify --splitting --format=esm`, para que cada import dinámico genere su propio chunk incrustado en el binario.
- **CodeMirror 6 (editor por defecto)**, usando solo los paquetes necesarios: `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/search`, `@codemirror/autocomplete` y los paquetes `@codemirror/lang-*` de los lenguajes soportados, cargados de forma diferida según la extensión del archivo abierto.
- **Monaco Editor**: se carga con import dinámico únicamente cuando el usuario lo selecciona en el dropdown de la barra de herramientas. Sus web workers se empaquetan con esbuild y se sirven desde los assets embebidos (`MonacoEnvironment.getWorkerUrl`), nunca desde un CDN. El minimap del prompt humano se implementa con el minimap nativo de Monaco; en CodeMirror la opción se muestra deshabilitada o se omite si no hay una implementación ligera.
- Nunca mantengas los dos editores vivos a la vez: al cambiar de editor, destruye la instancia anterior para liberar memoria.
- El estado de cada documento abierto (contenido, cambios sin guardar, final de línea, mtime de apertura) vive en un modelo propio de la app, independiente del editor, para que cambiar entre CodeMirror y Monaco no pierda cambios sin guardar.
- `@xterm/xterm` con `@xterm/addon-fit`, cargado de forma diferida solo cuando el usuario abre la terminal.
- **Temas**: los 9 temas del prompt humano se implementan con variables CSS sobre `<html data-theme="...">`. Cada tema define también su versión para CodeMirror (`EditorView.theme` + `HighlightStyle`), para Monaco (`monaco.editor.defineTheme`) y para xterm. Al iniciar: tema guardado en `localStorage`; si no existe, `prefers-color-scheme` decide entre Dark y Light. Todo acceso a `localStorage` va dentro de `try/catch`.
- **Iconos**: un único sprite SVG inline con `<symbol>`, dibujado a mano, reutilizado con `<use>`.
- **Visores**: imágenes, video y audio con las etiquetas nativas del navegador; PDF con el visor nativo del navegador (`<iframe>`/`<embed>`), sin pdf.js, para no añadir peso.
- **Móvil**: barra lateral como panel deslizable colapsable, botones táctiles de al menos 40 px, menús desplegables a ancho completo, aprovechamiento del soporte táctil nativo de CodeMirror. Monaco funciona mal en pantallas táctiles: si la pantalla es pequeña y el usuario elige Monaco, muestra un aviso recomendando CodeMirror (sin impedir el cambio).

## Sistema de archivos y API

- API REST para: listar directorio, leer archivo, guardar archivo, crear archivo o carpeta, renombrar/mover, copiar/pegar, duplicar y borrar (con confirmación en la GUI).
- **Selector de workspace**: un endpoint aparte que navega desde la raíz del host (`/` en Linux; en Windows, la lista de unidades disponibles `C:\`, `D:\`, etc.). Este endpoint solo lista directorios, nunca contenido de archivos, y requiere sesión iniciada.
- Una vez elegido el workspace, queda asociado a la sesión en el servidor y todas las operaciones de archivos quedan confinadas a él.
- El árbol de archivos se carga de forma perezosa: solo se lista un directorio cuando el usuario lo expande. Nunca recorras todo el árbol recursivamente.
- Lee y escribe archivos en streaming cuando sea posible. Límite de 5 MB para abrir archivos en el editor, con aviso si se supera.
- Detecta archivos binarios (byte NUL en los primeros 8 KB o UTF-8 inválido) y no los abras en el editor. Los archivos multimedia se enrutan al visor por extensión/MIME.
- Sirve audio y video con soporte de peticiones `Range` (respuesta 206) para poder adelantar sin cargar el archivo completo en memoria.
- Preserva la codificación UTF-8, el BOM si existía y los finales de línea originales (LF/CRLF) al guardar.
- Guardado con detección de conflictos: si el archivo cambió en disco desde que se abrió (comparando fecha de modificación y tamaño), avisa antes de sobrescribir.
- Escritura atómica: guarda en un archivo temporal en el mismo directorio y luego renómbralo. Si algo falla, borra el temporal: el prompt humano exige que no quede ningún fichero residual en el workspace (tampoco cachés, locks ni configuraciones; todo va en `~/.tendril`).

## Seguridad (crítico)

- **Path traversal**: toda ruta recibida se canonicaliza y se verifica que queda dentro del workspace de la sesión, incluyendo enlaces simbólicos que apunten fuera. Para archivos nuevos, canonicaliza el directorio padre. En Windows: normaliza el prefijo `\\?\`, compara sin distinguir mayúsculas, rechaza nombres reservados (`CON`, `NUL`, `COM1`…) y alternate data streams (`:` en el nombre).
- Tests de integración específicos para path traversal: rutas con `../`, rutas absolutas, enlaces simbólicos, codificación URL (`%2e%2e`, doble codificación), barras invertidas y letras de unidad en Windows.
- **Contraseña** (según el prompt humano): prioridad `--password` > `settings.json` > contraseña aleatoria de 8 caracteres alfanuméricos generada con CSPRNG y mostrada una única vez en consola. Comparación en tiempo constante.
- **Sesión**: token aleatorio de 256 bits guardado solo en memoria (reiniciar la app invalida todas las sesiones), en cookie `HttpOnly`, `SameSite=Strict`, `Path=/` y `Secure` en modo HTTPS.
- Todas las rutas, incluido el WebSocket de la terminal, exigen sesión válida, excepto la pantalla de login y sus assets.
- **Lista negra** (según el prompt humano): 3 intentos fallidos bloquean la IP en memoria hasta reiniciar el proceso. Una IP bloqueada recibe 403 en todo. El contador debe ser atómico para que intentos en paralelo no superen el límite. Documenta en CLAUDE.md que varios usuarios detrás de la misma IP pública o salida de VPN quedarán bloqueados juntos.
- **CSRF / WebSocket hijacking**: verifica la cabecera `Origin` en toda petición que modifique datos y en el upgrade del WebSocket.
- **Cabeceras**: `Content-Security-Policy` estricta sin scripts inline (ajustando lo mínimo que Monaco y los workers requieran), `X-Content-Type-Options: nosniff`, `frame-ancestors 'self'` (necesario para el visor PDF), `Referrer-Policy: no-referrer`.
- **Archivos del workspace servidos al navegador**: nunca sirvas HTML o SVG del workspace como contenido activo bajo el origen de la app (un HTML malicioso podría robar la sesión y usar la terminal). Sírvelos con `Content-Security-Policy: sandbox` o `Content-Disposition: attachment`; los SVG se muestran solo dentro de `<img>`.
- Límite de tamaño en el cuerpo de las peticiones.
- Escucha por defecto en `0.0.0.0` (según el prompt humano); `--bind` permite restringirlo.
- Nunca registres en los logs la contraseña, tokens de sesión ni contenido de archivos.

## HTTPS con rcgen

- En cada arranque se genera un certificado autofirmado nuevo con `rcgen`, sobrescribiendo el anterior en `~/.tendril/cert/` (`cert.pem` y `key.pem`; en Linux, la clave con permisos `600`).
- Incluye como SAN: `localhost`, `127.0.0.1`, `::1`, el nombre del host y las IPs de las interfaces locales si se pueden obtener sin dependencias pesadas.
- Como el certificado cambia en cada ejecución, el navegador mostrará la advertencia cada vez; es esperado. Imprime en consola la huella SHA-256 para que el usuario pueda verificarla.
- `tendril http` arranca sin TLS, sin el flag `Secure` en la cookie, y muestra un aviso en consola.

## Persistencia y logs

- Todo en `~/.tendril/` (`HOME` o `USERPROFILE`). El prompt humano menciona `./tendril/settings.json` y `.tendril/settings.json`: interprétalos ambos como `~/.tendril/settings.json` (Comentario humano: sí, correcto).
- `settings.json`: si no existe, se crea con valores por defecto; los campos ausentes toman su valor por defecto (`#[serde(default)]`), para que versiones futuras puedan añadir campos sin romper los ficheros existentes. Campos mínimos: `password` (opcional), `idle_timeout_minutes` (180), `port`, `default_editor`, `log_retention_days`. Escritura atómica.
- Logs: un fichero por día en `~/.tendril/logs/`, donde cada línea es un objeto JSON válido (JSON Lines), con escritura en buffer. Borra logs más antiguos que `log_retention_days` (30 por defecto) y limita el tamaño total para no llenar el disco de una Raspberry Pi.
- Eventos a registrar: arranque y parada, logins correctos/fallidos/bloqueos (con IP), workspace seleccionado, operaciones de archivo (ruta y tipo de operación, sin contenido), apertura/cierre de terminales, cambios de ajustes, errores, panics y cierre por inactividad.

## Timeout de inactividad

- Actividad = acciones del usuario: peticiones autenticadas iniciadas por el usuario y entrada en la terminal. Los heartbeats automáticos, el polling y los procesos que se ejecutan en la terminal sin intervención del usuario **no** reinician el contador; si lo hicieran, una pestaña olvidada abierta impediría el cierre.
- Un `tokio::time::interval` de un minuto comprueba el tiempo de inactividad; al superarlo, registra el evento, mata los PTYs y termina el proceso.
- En Settings, el valor mínimo es 1 minuto y no hay opción para desactivarlo; se permiten valores altos.
- El botón "terminar proceso" de Settings pide confirmación, mata los PTYs y cierra la app limpiamente.

## Terminal integrada

- Backend con `portable-pty`, comunicado con el frontend por WebSocket. Shell: en Linux `$SHELL` con respaldo `/bin/sh`; en Windows `powershell.exe` con respaldo `cmd.exe` (ConPTY, Windows 10 1809+).
- El directorio inicial de la terminal es el workspace.
- Soporta mensajes de redimensionado desde `@xterm/addon-fit`.
- Cierra el proceso PTY cuando se cierra el WebSocket, para no dejar procesos huérfanos consumiendo memoria. Limita el número de terminales simultáneas (por ejemplo, 4).

## Verificación visual

- Usa Chromium headless (con `--ignore-certificate-errors` por el certificado autofirmado) para tomar capturas de: login, selector de workspace, editor con CodeMirror, editor con Monaco, terminal abierta, visor multimedia y pestaña de ajustes.
- Captura cada pantalla relevante en los 9 temas y en dos tamaños: escritorio (1366×768) y móvil (390×844). Revisa las imágenes y corrige contraste, alineación, desbordes y elementos toscos antes de dar una fase por terminada.

## Estrategia de implementación

Construye por fases y verifica que compila y funciona antes de pasar a la siguiente:

1. Esqueleto: argumentos, `~/.tendril`, settings, logs, HTTPS con rcgen y modo `http`, frontend embebido.
2. Autenticación: login, sesiones, lista negra, cabeceras de seguridad.
3. Selector de workspace y API de sistema de archivos con sus protecciones y tests.
4. Interfaz base: menús, barra de herramientas, árbol, pestañas, temas y adaptación móvil.
5. CodeMirror 6; después, cambio a Monaco.
6. Visores de imagen, video, audio y PDF.
7. Terminal.
8. Timeout de inactividad, pestaña de ajustes y botón de terminar proceso.
9. Verificación visual de todos los temas en escritorio y móvil.
10. Clippy, build release, tamaño y RSS, pruebas en Windows 10 y CLAUDE.md.

<!-- ============================================================== -->
<!-- FIN DE LA SECCIÓN DE RECOMENDACIÓN DE IA (CLAUDE)               -->
<!-- ============================================================== -->

# Detalles Finales

El código debe estar escrito y documentado de forma completamente versatil y escalable de modo que sea sencillo implementar nuevas caracteristicas en medio, antes o después de otras como piezas de lego.

Documenta con comentarios todo el código para que posteriormente un Agente de IA le sea sencillo comprender el código.

No pares hasta que todos los puntos estén resueltos.

Cuando termines, escribe el fichero CLAUDE.md correspondiente para este proyecto con todo lo relevante.
````

Second prompt, given after the developer had tried the first version by hand on Linux, Windows 10 and a phone. It refers to `pruebas-desarrolladora.md`, the manual test checklist written for the developer: a working file, not kept in the repository. The answers given there decided this round (git through the host's `git`, the split editor, remote images in the Markdown preview, the visible idle countdown, the `terminal_shell` fallback) and are recorded in [`../CLAUDE.md`](../CLAUDE.md), section 10.

````
Primero te comento: me encanta la app. Es posible que la use mucho para controlar mis ordenadores de forma remota.

En fin.

He leido el markdown `pruebas-desarrolladora.md`.

He colocado comentarios, respuestas y algunas cosas para que revises e integres.

Si alguna de las cosas marcadas, solicitadas o respondidas te generan preguntas antes de realizar los cambios, coloca antes una seccion abajo del todo en el mismo markdown llamada `Tanda de Preguntas` o algo asi donde escribiras tus preguntas y yo respondere las aclaraciones correspondientes.

Hay un bug minimo o quizá un detalle intencional: al hacer clic en uno de los botones superiores del navegador (File, Edit, Selection, ...), este se abre, al darle clic de nuevo desaparece y vuelve a abrirse. La intuición es que al darle clic mientras ya estaba abierto es que cierre. Se cierra dando clic en otro lado. Ajustalo para que se cierre si ya esta abierto.

Si no tienes preguntas, continua con los cambios minimos que en el markdown `pruebas-desarrolladora.md` te planea (integracion vista previa markdown, git, visor dividido, algo de la terminal, etc).

El cambio en Git para hacer squash lo dejariamos para despues.
````
