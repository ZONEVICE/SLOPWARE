The live maintenance guide for this application is [`../CLAUDE.md`](../CLAUDE.md).
This file only keeps the original prompt, as history: it is not a specification
to re-execute.

Prompt used to create this application:

```
Crea el directorio `allyswally`. Vas a crear la siguiente aplicación ahí.

# Detalles Tecnicos

Aplicación web con GUI completamente programada en HTML/CSS/JavaScript plano. Servidor completamente programado en Rust. Idealmente ninguna libreria, todo programado a mano a menos que sea necesario para una funcionalidad especifica.

La aplicación está diseñada para ejecutarse en host Windows 10/11 en formato chasis Handheld y ser utilizada en dispositivo móvil o tablet (sin limitarse a tamaño de pantalla desktop). Te ejecutarás en Host Windows 10 con Rust y AutoHotKey instalados. Tendras permiso administrador para todo lo que necesites. Tienes acceso a NodeJS y Python si te sirven para hacer pruebas exploratorias o tests.

La aplicación es una herramienta de asistencia para utilizar un host Handheld Windows. En concreto, el modelo Xbox Ally X, aunque la implementación sería agnostica a si es Windows en desktop, laptop, handheld o headless.

El servidor, programado en Rust, debe servir la GUI HTML/CSS/JavaScript por la red. Las ordenes recibidas de la GUI se ejecutan en el servidor Rust, aprovechando toda su Standard Library.

Se debe generar un único fichero `.exe` que cumpla todas las funcionalidades.

El servidor web se ejecuta unicamente por HTTP. Cuando haya una conexión nueva al servidor, se solicitará un PIN de 6 digitos de acceso. Colocarlo mal 3 veces bloquea ese cliente y para desploquearlo hay que cerrar el proceso Rust y volverlo a ejecutar. El PIN se muestra en la consola al abrir el `.exe`. La persistencia de usuarios se guarda en la memoria y se pierde al reiniciar. El PIN se genera de forma aleatoria y puede contener A-Z y 0-9.

Al iniciar la aplicación, siempre se muestra una pantalla de consola. En ella se muestra en letras bastante grandes, coloreado y con arte ANSI en nombre de la aplicación "AllySwally". Abajo, se muestra en letra más pequeña pero facilmente identificable la IP del host para acceder a la aplicación web y el PIN de acceso. Se muestran logs en tiempo real de uso en la consola. Todo escrito en inglés.

La aplicación debe crear un directorio en `%USERPROFILE%\.allyswally` para persistencia de datos. Los logs anteriormente mencionados, se escriben de forma eficiente en `.allyswally/logs` en formato JSON. Estos logs incluyen datos de uso, desconexiones inesperadas, posibles bugs encontrados para reparar después y agrega cualquier otra cosa que te parezca relevante. Aquellos logs antiguos se remueven automaticamente en un rango prudencial.

# Diseño 

La GUI debe estar optimizada para usar en teléfonos móviles. Formato Responsive First con compatibilidad resoluciones de tablet y desktop.

Al ingresar, se solicita el PIN de acceso y no puede hacerse nada hasta que se ingrese el PIN correcto.

Una vez dentro de la app web, se presenta un navegador superior pequeño con iconos descriptivos según corresponda. Hay un total de 4 tabs que se explicarán en la sección de funcionalidades.

La aplicación por defecto está en tema modo oscuro. Los temás son simplemente esquemas de color, algunos pocos con caracteristicas unicas. Se desglozan a continuación:

- Dark: Modo por defecto. Es oscuro y simple. Elegante.
- Light: Opuesto del modo oscuro.
- Dark OLED: Modo oscuro con colores en absolutos negros y blancos. Sensación terminal hacker.
- RGB: Modo colorido donde hay una animación tenue y suave donde los colores cambian.
- Kirby: Paleta de colores rosa del personaje Kirby de Nintendo.
- Gorbino: Tema sumamente desagradable y feo a proposito. Inspirado en el estilo de Cruelty Squad. Busca en Internet referencias visuales del video juego y replicalo como puedas. No cambia el HTML, sólo colores y letras.

Si se te ocurre algún tema más que sea interesante. Crealos. El tema seleccionado se guarda en el LocalStorage del cliente así que se recuerda su tema seleccionado.

Recuerda que todo debe encajar en un teléfono móvil. Se sumamente prudencial con la escala y tamaño de letras, botones y zonas de trabajo. Debe tener sentido que se quiere que sea grande y que se pequeño. Por ejemplo, no queremos botones enormes que tomen toda la pantalla dejando una funcionalidad escencial pequeña o con poco margen.

# Funcionalidades

La aplicación, como se mencionó, es una herramienta de asistencia.

A continuación cada funcionalidad o sección que puede encontrarse en los 4 tabs mencionados.

Obviamente cada funcionalidad, cuando se habla del efecto obtenido, es el reflejado en el Host Windows. Las ordenes provienen de la GUI siendo presentada en el dispositivo móvil.

## Tab 1: Mouse

Con icono de Mouse, este tab muestra un trackpad virtual al estilo de una laptop. Diseñado para precisamente una pantalla tactil de dispositivo móvil. Deslizar el dedo, mueve el mouse en el Host. Hay un slider para controlar la velocidad de DPI virtual (de ser posible sin cambiar nada de la configuracion del host Windows).

Hacer un tap, envía un clic. Doble tap un doble clic. De ser posible, al arrastrar dos dedos se realiza scroll con velocidad proporcional al desliz de los dedos.

Hay botones virtuales abajo para clic derecho, izquiero y central.

Hay un scroll vertical en estilo potenciometro para hacer scroll vertical.

Hay una pequeña sección invisible a primera vista en la parte posterior para ejecutar atajos. Se verá a más profundidad más adelante.

El diseño debe ser limpio y amplio. Hay un botón para mostrar y ocultar opciones adicionales como la del potenciometro de DPI.

Agrega todo aquello que te parezca interesante. No me importa que agregues, siempre y cuando la funcionalidad fundamental de trackpad y botones virtuales de mouse no se vean achicados o abrumados por tantas cosas en pantalla.

## Tab 2: Teclado

Icono de teclado.

Aquí podemos encontrar un teclado virtual para enviar pulsaciones de teclas al host. Estos teclados son completamente programados con HTML/CSS/JavaScript.

Los teclados se ven afectados por el tema seleccionado.

Hay posibilidad de hacer un toggle de varios estilos de teclados. Teclados 100%, 80%, 60%, 40%, 20%. Agrega cualquier otro teclado que te parezca interesante en modos compactos o completos. Si quieres incluso agrega teclados extraños o sin sentido.

Con un botón, sin necesidad de cambiar la horientación del dispositivo móvil, el teclado se puede colocar en horizontal.

Hay un pequeño centro de comandos para enviar ciertas pulsaciones de teclas extra como F<x> o súbir/bajar volumen.

Hay un modo de teclado que permite abrir y utilizar el teclado nativo del dispositivo. Es decir, por ejemplo, si la GUI está en un dispositivo Android, el botón que abre el teclado nativo, abriría, por ejemplo; el GBoard o bien el teclado instalado para utilizarlo comodamente.

Al igual que la funcionalidad anterior, si se te ocurren otras cosas interesantes, agregalas.

Hay también, al igual que Mouse, pequeña sección invisible a primera vista en la parte posterior para ejecutar atajos. Se verá a continuación para que se usa.

## Tab 3: MASKED

Icono que te parezca apropiado según lo que te voy a explicar.

Esta es la funcionalidad más poderosa de todas dirigidas a los Power Users.

### Diseño

Tenemos aquí otro navegador vertical o horizontal. Elige el que encaje mejor.

### Funcionalidades

Tenemos 4 funcionalidades maestras:

1: Atajos de teclado. Podemos crear aquí atajos de teclado. Por ejemplo `CTRL + C` o `ALT + F4`. Crea una selección obvia de atajos que cualquiera quisiera tener. Por ejemplo para cerrar el app en focus, ALT + TAB, Inicio, etc.

2: Abrir/Ejecutar. Podemos guardar una ruta de directorio, URL o ejecutable para enviar al Host la orden de abrir ese directorio o página web o binario automaticamente.

3: Clipboard: Un clipboard para enviar al host. Podemos guardar `n` items para enviar al host y lo pegue en lo que sea que tenga focus.

4: Ejecutar Código: Sí, podemos enviar una instrucción CMD. Si la app `.exe` está ejecutada como administrador, queda a responsabilidad del usuario lo que haga. Bien, aquí lo que podemos hacer ejecutar código CMD directamente. Se puede guardar esa linea o lineas de código par usar después. También podemos es colocar una dirección fisica en el Host que llega a un archivo de código y ordena que el Host lo ejecute. Los lenguajes de programación categorizados son Python, NodeJS y AutoHotKey. Cualquier otro se guardaría como "Other". Se pueden guardar esos atajos también.

Los puntos 1, 2, 3 y 4 pueden ser guardados y persistidos para su uso incluso después de cerrar el servidor. Se guardan en `%USERPROFILE%\.allyswally\user-data`. Cada item se guarda con un nombre, descripción, si se muestra en la banda de atajos y de ahí en adelante todos los parametros necesarios y extras que te parezca interesante agregar. No hay perfiles ni usuarios así que la configuración guardada es global.

Decide tú como organizar los datos persistitos, pero asume que un humano puede ir y editarlos cuando quiera para no pasar por la app para editarlos. Así que usa, por ejemplo, JSON.

Debe ser posible ajustarlos en caliente y que la app los recargue automaticamente si detecta un cambio o cada vez que se ingrese a la sección se vuelvan a cargar para asegurar que los cambios se cargaron.

### Acceso en todas partes

En la sección se pueden hacer el CRUD completo y ejecutarlos como es obvio, pero ir al tab MASKED cada vez que se quiera ejecutar, por ejemplo, un atajo o un comando especifico de AutoHotKey resulta poco practico.

Anteriormente te mencioné una sección invisible en las funciones anteriores. Se trata de una banda scrollable de forma horizontal en la parte superior de las funcionalidades Mouse y Teclado. En esa banda horizontal, hay botones con los nombres de los items de las 3 funciones maestras que se pueden ejecutar inmediatamente con un tap. Se muestran solo los items marcados para mostrar en la banda de atajos, obviamente.

## Tab 4: Configuración

Icono de engranaje.

Sección de ajustes, información y acciones de mantenimiento. Se organiza en grupos plegables (acordeón) para que quepa cómodamente en un móvil. Cada ajuste indica con una pequeña etiqueta su alcance:

- **Dispositivo**: se guarda en el LocalStorage del cliente y solo afecta a ese móvil o tablet.
- **Host**: se guarda en `%USERPROFILE%\.allyswally\user-data\config.json` y afecta a todos los clientes. Es editable a mano y se recarga en caliente como el resto de ficheros.

Las acciones destructivas o de energía requieren **mantener pulsado** el botón durante aproximadamente 1 segundo, con una barra de progreso de relleno, para evitar toques accidentales. Todas quedan registradas en el log.

### Apariencia (Dispositivo)

- Selector de tema con vista previa en miniatura de cada uno.
- Escala de la interfaz (por ejemplo, 85 %–130 %) para adaptar el tamaño a cada pantalla.
- Vibración háptica: activada o desactivada, e intensidad (solo Android).
- Reducir animaciones, que además respeta `prefers-reduced-motion`.
- Mostrar u ocultar la banda de atajos por defecto.
- Botón de pantalla completa.

### Mouse (Dispositivo)

- Sensibilidad (DPI virtual) por defecto.
- Curva de aceleración: ninguna, suave o fuerte.
- Modo de movimiento: absoluto (predecible, por defecto) o relativo (para juegos).
- Velocidad de scroll y scroll natural (invertido) al estilo trackpad.
- Tap para clic activado/desactivado y tiempo máximo del doble tap.
- Modo zurdo: invierte los botones izquierdo y derecho y espeja la disposición de los controles.

### Teclado (Dispositivo)

- Distribución de teclado por defecto y orientación por defecto (normal u horizontal).
- Repetición de tecla al mantener pulsado: retardo inicial y velocidad.
- Sonido de pulsación opcional, generado con Web Audio, sin ficheros de audio.
- Teclado nativo: envío inmediato carácter a carácter, o modo búfer donde se escribe y corrige en el móvil y se envía todo junto con un botón "Enviar".

### Conexión

- Estado en vivo: conectado o reconectando, latencia actual en ms con un mini gráfico de los últimos segundos, IP del host e interfaz usada (Wi-Fi, Bluetooth PAN, USB…).
- Lista de clientes conectados al servidor: IP, tiempo de conexión y cuál es "este dispositivo".
- **Cerrar sesión**: olvida el token de este dispositivo y vuelve a pedir el PIN.

### Host

Información:

- Nombre del equipo y versión de Windows.
- **Batería del host**: porcentaje, si está cargando y tiempo restante estimado (`GetSystemPowerStatus`). Es especialmente útil en una handheld.
- Tiempo encendido del host y del servidor.
- Si el servidor corre elevado (administrador), con una advertencia explicando las limitaciones si no lo está.
- Estado de la regla del firewall.

Acciones de energía (todas con mantener pulsado):

- Bloquear sesión.
- Apagar pantalla (`SC_MONITORPOWER`), útil para ahorrar batería mientras se controla el host desde el móvil.
- Suspender.
- Reiniciar.
- Apagar.

### Datos

- **Exportar configuración**: descarga un único JSON con todos los items de MASKED y `config.json`. Funciona por HTTP generando un Blob en el cliente.
- **Importar configuración**: sube ese JSON. El usuario elige entre combinar con lo existente o reemplazarlo.
- **Restablecer ajustes de este dispositivo**: borra el LocalStorage.
- **Restablecer datos del host**: devuelve los ficheros de `user-data` a los valores predeterminados. Antes de cualquier restablecimiento o importación, el servidor guarda automáticamente una copia de seguridad con fecha en `.allyswally\backups`, que también se rota por antigüedad.
- **Abrir carpeta de datos en el host**: abre `%USERPROFILE%\.allyswally` en el Explorador.

### Diagnóstico

- Visor de los últimos logs (por ejemplo, las 200 últimas líneas) con filtro por nivel (info, warning, error), para diagnosticar problemas desde el móvil sin acercarse a la consola.
- Errores de JSON pendientes: si algún fichero de `user-data` editado a mano es inválido, se muestra aquí con fichero, línea y columna.
- Botón para probar la latencia bajo demanda.

### Servidor (todas con mantener pulsado)

- **Regenerar PIN**: genera un PIN nuevo, lo muestra en la consola del host, invalida todas las sesiones y expulsa a todos los clientes, incluido este.
- **Detener servidor**: cierra el proceso de forma limpia, vaciando los logs.
- No existe opción para desbloquear IPs bloqueadas por PIN incorrecto. Por diseño, eso solo se resetea reiniciando el proceso.

### Acerca de

- Nombre, versión y fecha de compilación.
- Icono de la app (SVG de una Handheld roja con cuernos). Se usa también en el tab del browser.
- Nombre del desarrollador y IA utilizada (Claude Code Opus 5.5 Max Effort).
- **Guía de gestos**: una superposición breve e ilustrada (con CSS/SVG propios) que explica los gestos del trackpad y la banda de atajos. Se muestra automáticamente la primera vez que se entra a la app y se puede volver a abrir desde aquí.

# Recomendaciones técnicas y detalles adicionales

> **Nota:** Esta sección fue redactada por Claude (Anthropic) en conversación con la autora durante la fase de planificación del proyecto, antes de ejecutar este prompt. Recoge decisiones técnicas, riesgos detectados y aclaraciones. Si algo de esta sección contradice al resto del prompt, prevalece el resto del prompt, salvo en lo que aquí se marca explícitamente como aclaración de una ambigüedad.

## Dependencias

- Política: `std` de Rust más, como única dependencia permitida, el crate oficial de Microsoft **`windows-sys`** para los bindings Win32. Es una colección de declaraciones FFI sin lógica propia. Si se prefiere, el FFI puede declararse a mano con `extern "system"`; queda a criterio de la implementación, documentándolo en CLAUDE.md.
- Prohibido: tokio, hyper, axum, serde, rand, tungstenite o cualquier framework. Todo lo siguiente se programa a mano:
  - parser HTTP/1.1 mínimo;
  - WebSocket (RFC 6455): handshake con SHA-1 + Base64 propios y framing de texto, binario, ping, pong y close;
  - parser y serializador JSON;
  - escritura de logs.
- Cada componente hecho a mano lleva tests unitarios (`cargo test`). El handshake WebSocket se valida contra el ejemplo del RFC 6455 (clave `dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) y SHA-1 contra vectores de prueba conocidos.
- Frontend: HTML/CSS/JS vanilla, sin frameworks ni librerías, embebido en el binario con `include_str!` / `include_bytes!`.

## Arquitectura del servidor

- Concurrencia con hilos de `std` (un hilo por conexión), sin async. Los clientes simultáneos esperados son 1–3.
- Puerto fijo por defecto (por ejemplo 8787) para poder guardar marcadores. Debe ser configurable por argumento de línea de comandos; si está ocupado, informar claramente en consola.
- Instancia única mediante un mutex con nombre de Windows. Si ya hay una instancia ejecutándose, avisar y salir.
- Hook de `panic` global y aislamiento por conexión: un pánico en un hilo de cliente se registra en logs como bug y nunca tumba el servidor.
- Para la consola, habilitar `ENABLE_VIRTUAL_TERMINAL_PROCESSING` con `SetConsoleMode` y fijar la salida a UTF-8 (`SetConsoleOutputCP(65001)`). Sin esto, los colores ANSI y el arte no se ven bien en el conhost de Windows 10.
- Al arrancar, detectar si el proceso está elevado y mostrarlo en consola. Sin elevación, Windows (UIPI) bloquea en silencio la inyección de input en ventanas elevadas como el Administrador de tareas o apps ejecutadas como admin. La pantalla de UAC (escritorio seguro) es inaccesible en cualquier caso; esto debe quedar documentado.

## Autenticación y sesión

- PIN de 6 caracteres generado con aleatoriedad criptográfica del sistema (`BCryptGenRandom` o `ProcessPrng`), nunca con relojes ni hashes del tiempo.
- Alfabeto A-Z y 0-9 **excluyendo caracteres ambiguos** (0/O, 1/I/L) para facilitar la lectura en la consola de una handheld. El input del PIN en la GUI convierte a mayúsculas automáticamente y desactiva autocorrección y autocompletado.
- El bloqueo tras 3 fallos es **por dirección IP del cliente** y vive en memoria hasta reiniciar el proceso, como pide el prompt.
- Tras un PIN correcto, el servidor emite un token de sesión aleatorio que el cliente guarda en LocalStorage y presenta al reconectar el WebSocket, para no pedir el PIN en cada microcorte. Al reiniciar el servidor, todos los tokens quedan invalidados.
- Ninguna ruta de la API ni el WebSocket funcionan sin token válido. Solo se sirven sin autenticar el HTML, el CSS, el JS y el endpoint del PIN.

## Agnosticismo de transporte: Wi-Fi, hotspot, Bluetooth PAN y USB

La app debe funcionar sin cambios sobre cualquier red IP que conecte el móvil con el host. Además de la Wi-Fi doméstica, son escenarios reales de uso:

- **Bluetooth PAN.** El móvil Android activa "Compartir conexión por Bluetooth" y el host Windows se une como cliente ("Conectar mediante → Punto de acceso"). El móvil suele quedar en `192.168.44.1` y el host recibe una IP de esa subred por DHCP. No requiere instalar nada en Android ni datos móviles. Windows solo puede ser cliente PAN, por eso el que comparte es el teléfono.
- **Hotspot Wi-Fi del móvil**, con el host conectado a él.
- **Anclaje USB** del móvil (red RNDIS por cable).

Requisitos que se derivan de esto:

- **Interfaces.** El servidor escucha en `0.0.0.0`.
- **Sin direcciones hardcodeadas en el frontend.** El WebSocket se construye como `ws://${location.host}/ws` y todas las rutas son relativas.
- **Detección de IPs.** Se enumeran todas las IPv4 activas con `GetAdaptersAddresses` (iphlpapi), etiquetadas por tipo de interfaz en consola (Wi-Fi, Ethernet, Bluetooth PAN, USB/RNDIS) y omitiendo loopback y APIPA (`169.254.x.x`).
- **Refresco en caliente.** La lista de IPs se refresca periódicamente (por ejemplo, cada 5 s). La interfaz PAN aparece cuando se conecta el Bluetooth, normalmente después de arrancar el servidor. Cuando cambien las IPs, se actualiza la consola y se escribe un evento en el log.
- **Firewall.** Las redes PAN y USB suelen clasificarse como **Pública** o "Red no identificada". Si el proceso está elevado, al arrancar comprueba o crea una regla de entrada del Firewall de Windows para el puerto, válida en los perfiles Privado **y** Público (vía `netsh advfirewall`). Si no está elevado, muestra un aviso claro en consola con el comando exacto a ejecutar.
- **Tolerancia a latencia alta.** Por Bluetooth PAN se esperan 20–50 ms con jitter y unos 1–2 Mbps de ancho de banda:
  - El movimiento del trackpad se envía como **deltas acumulados**, coalescidos una vez por `requestAnimationFrame`, en mensajes WebSocket **binarios compactos** (por ejemplo, 1 byte de tipo + 2 × i16). Nunca un mensaje por cada evento `pointermove`.
  - `set_nodelay(true)` en todos los sockets (desactivar Nagle).
  - La UI es optimista: los botones dan feedback visual y háptico inmediato, sin esperar confirmación del servidor.
  - Los assets se mantienen pequeños y se sirven con `ETag` / `Cache-Control` para que recargar sobre Bluetooth sea rápido.
- **Reconexión robusta.** Heartbeat ping/pong cada pocos segundos para detectar conexiones muertas (el modern standby del host corta la red al suspender). El cliente reconecta automáticamente con backoff exponencial, reautentica con su token y muestra un indicador discreto de estado.
- **Latencia visible.** Ajustes muestra la latencia actual (RTT del heartbeat) y opcionalmente un indicador pequeño en la barra superior.
- **Documentación.** CLAUDE.md incluye una guía breve de cómo conectar por Bluetooth PAN, hotspot del móvil y USB.

## Inyección de input (Win32 `SendInput`)

- **Texto** (teclado nativo del móvil, Clipboard en modo "teclear"): `KEYEVENTF_UNICODE`. Envía el carácter real independientemente de la distribución de teclado del host, así que ñ, tildes y emojis funcionan; los emojis requieren pares sustitutos UTF-16.
- **Teclas y atajos**: **scancodes** (`KEYEVENTF_SCANCODE`) con `KEYEVENTF_EXTENDEDKEY` donde corresponda (flechas, Insert/Delete, Home/End, AvPág/RePág, Ctrl y Alt derechos, tecla Windows). Muchos juegos ignoran los códigos virtuales.
- **Combinaciones**: se pulsan los modificadores en orden y se sueltan en orden inverso. Una tecla nunca puede quedarse "pegada": si el WebSocket se cae a mitad de combinación, el servidor libera todas las teclas y botones que ese cliente tenga pulsados.
- **Multimedia**: volumen, silencio y play/pause por códigos virtuales (`VK_VOLUME_UP`, etc.).
- **Velocidad del cursor sin tocar la configuración de Windows**:
  - El multiplicador de "DPI virtual" se aplica en el cliente.
  - El movimiento relativo de `SendInput` se ve afectado por "Mejorar precisión del puntero". Para un control predecible, el modo por defecto calcula la nueva posición absoluta a partir de `GetCursorPos` y la aplica de forma absoluta sobre el escritorio virtual, contemplando multimonitor.
  - Se ofrece además un modo "relativo" (`MOUSEEVENTF_MOVE`) para juegos que leen raw input.
  - Se usa una curva de aceleración propia, opcional y configurable en el cliente.
- **Scroll**: `MOUSEEVENTF_WHEEL` con deltas inferiores a 120 para scroll de alta resolución suave, y `MOUSEEVENTF_HWHEEL` para el scroll horizontal con dos dedos.
- **Arrastrar**: además del tap, se soporta el gesto de tap + mantener + deslizar (como en un trackpad de portátil) y un botón de "bloqueo de clic" para arrastrar con comodidad.

## MASKED: ejecución y persistencia

- **Abrir/Ejecutar**: `ShellExecuteW` con el verbo `open` para rutas, URLs y ejecutables.
- **Clipboard**: se escribe en el portapapeles del host con `OpenClipboard` / `SetClipboardData(CF_UNICODETEXT)` y luego se envía Ctrl+V. Opcionalmente se restaura el contenido previo del portapapeles. Cada item ofrece el modo alternativo "teclear" con `KEYEVENTF_UNICODE`, para campos que bloquean el pegado.
- **Ejecutar código**:
  - `std::process::Command` sin ventana visible (`CREATE_NO_WINDOW`) para comandos CMD cortos. Se capturan stdout y stderr con límite de tamaño y timeout configurable, y el resultado se muestra en la GUI.
  - Los scripts de larga duración (por ejemplo, AutoHotKey residente) se lanzan desacoplados, sin timeout ni captura.
- **Intérpretes**: las rutas de Python, NodeJS y AutoHotKey se configuran en un fichero de configuración editable, con autodetección inicial: `PATH`, `py` launcher, y las rutas típicas de AutoHotKey v1 y v2 (`C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe`). Se distinguen AutoHotKey v1 y v2.
- **Seguridad**: la ejecución de código es remota por diseño. La GUI pide confirmación antes de ejecutar items de código, salvo que el item tenga marcado "ejecutar sin confirmar". Todos los comandos ejecutados quedan registrados en el log de auditoría.
- **Persistencia en `%USERPROFILE%\.allyswally\user-data`**:
  - Un fichero JSON por categoría (`shortcuts.json`, `launchers.json`, `clipboard.json`, `scripts.json`) más `config.json`, con formato legible e indentado y un campo `"version"` para migraciones futuras.
  - Cada item tiene un `id` estable aleatorio, `name`, `description`, `showInBand`, `order`, `color` / `icon` opcionales, `createdAt` y `updatedAt`, además de sus campos específicos.
  - **Escrituras atómicas**: se escribe en un fichero temporal y luego se renombra, para no corromper nunca un fichero que una persona esté editando.
  - **Recarga en caliente**: se vigila el `mtime` de los ficheros (sondeo ligero de 1–2 s, o `ReadDirectoryChangesW`) y se recarga además al entrar al tab MASKED. Los clientes conectados reciben un aviso por WebSocket para refrescar la banda de atajos.
  - **Tolerancia a errores humanos**: si un JSON editado a mano es inválido, se mantiene la última versión válida en memoria, se registra el error con línea y columna, se muestra un aviso en la GUI y **nunca se sobrescribe** el fichero roto.
- **Atajos predefinidos**: en el primer arranque se crea un set razonable que el usuario puede borrar: copiar, pegar, cortar, deshacer, rehacer, seleccionar todo, Alt+Tab, Alt+F4, Ctrl+W, Ctrl+Shift+T, Win, Win+D, Win+E, Win+Tab, Ctrl+Shift+Esc, captura de pantalla (Win+Shift+S), Barra de juegos (Win+G), bloquear (Win+L).

## Logs

- Formato **JSON Lines** (un objeto JSON por línea) en `%USERPROFILE%\.allyswally\logs`, con un fichero por día (por ejemplo `2026-10-08.jsonl`).
- Escritura con buffer y flush periódico (por ejemplo, cada segundo) y al cerrar.
- Retención por defecto de 14 días, configurable en `config.json`; los ficheros antiguos se borran al arrancar y una vez al día.
- Contenido: arranque y apagado, IPs e interfaces, conexiones y desconexiones (indicando si fueron inesperadas o por timeout de heartbeat), intentos de PIN fallidos y bloqueos, acciones ejecutadas, errores de JSON, pánicos con backtrace y errores de `SendInput`.
- **Privacidad**: nunca se registra el contenido de lo tecleado ni del clipboard, porque podrían ser contraseñas. Solo se registran tipo y conteo (por ejemplo, "text input, 12 chars"). Los comandos ejecutados sí se registran completos, como auditoría.

## GUI móvil: detalles técnicos

- **Viewport y gestos del navegador**:
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
  - Uso de `100dvh` y `env(safe-area-inset-*)`.
  - `overscroll-behavior: none` para evitar el pull-to-refresh.
  - `touch-action: none` en el trackpad y en el teclado.
  - `user-select: none` y `-webkit-tap-highlight-color: transparent`.
  - Pointer Events en lugar de touch events.
- **Teclado nativo del móvil**:
  - Se usa un `<textarea>` oculto enfocado desde un gesto directo del usuario, imprescindible en iOS.
  - Con Gboard y otros IME, `keydown` devuelve `keyCode 229`, así que hay que basarse en `beforeinput` / `input` y calcular el diff del valor. Esto cubre composición, autocorrección que reemplaza palabras completas, borrado y Enter.
  - Se mantiene un texto centinela en el textarea para poder detectar Backspace con el campo "vacío".
- **Contexto no seguro**: al servirse por HTTP, el navegador **no** es un contexto seguro. Clipboard API, Wake Lock y service workers no están disponibles; se detectan por feature detection y la app nunca depende de ellos. Fullscreen API y `navigator.vibrate` sí funcionan y se usan (háptica configurable, solo Android).
- **Teclado en horizontal**: se gira con `transform: rotate(90deg)` intercambiando ancho y alto del contenedor. Hay que verificar que los toques caen en la tecla correcta tras la rotación.
- **Banda de atajos**: discreta, desplazable horizontalmente con inercia nativa y sin robar altura útil al trackpad ni al teclado. Se puede colapsar.
- **Temas**: implementados exclusivamente con CSS custom properties sobre un atributo `data-theme` en `<html>`. Los temas Kirby y Gorbino son solo paletas de color y tipografía inspiradas en esas obras: no se incluyen imágenes, sprites, logos ni assets de esos juegos. El tema RGB respeta `prefers-reduced-motion`.
- **Accesibilidad**:
  - Contraste suficiente en todos los temas salvo Gorbino, que es feo a propósito, pero aun así debe ser legible.
  - Objetivos táctiles de al menos 44×44 px en los controles principales.
  - `aria-label` en todos los botones de icono.

## Proceso de verificación visual (screenshots)

- Usar **Microsoft Edge headless**, presente de serie en Windows, para capturar sin instalar nada. Ejemplo: `msedge --headless --screenshot=out.png --window-size=390,844 URL`. Si Node está disponible en el host de desarrollo, Playwright puede usarse **solo como herramienta de desarrollo**, nunca como parte del producto.
- Para poder capturar pantallas detrás del PIN, el binario acepta un flag de desarrollo (por ejemplo `--dev-no-auth`) que **solo existe en builds de debug** (`#[cfg(debug_assertions)]`) y nunca en release. La GUI acepta parámetros de URL como `?tab=mouse&theme=gorbino` para capturar cada combinación.
- Resoluciones mínimas a revisar: 360×800 y 390×844 (móvil vertical), 844×390 (móvil horizontal), 768×1024 (tablet) y 1280×800 (escritorio). Se capturan todos los tabs con al menos los temas Dark, Light y Gorbino, además del teclado en modo horizontal.
- Tras cada captura, revisar: textos cortados, desbordes horizontales, controles demasiado pequeños para un dedo, y áreas esenciales (trackpad, teclas) aplastadas por controles secundarios.

## Compilación

- Perfil release con `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = true` y `panic = "abort"` **solo si** no impide el aislamiento de pánicos por conexión. Si lo impide, mantener `unwind`.
- CRT estático (`-C target-feature=+crt-static` en `.cargo/config.toml`) para que el `.exe` funcione sin redistribuibles de Visual C++.
- Un manifiesto de aplicación embebido (DPI awareness per-monitor v2, para que las coordenadas absolutas del ratón sean correctas con escalado) es deseable si puede hacerse sin dependencias, mediante un script `build.rs` que invoque las herramientas del SDK.

# Detalles finales

Es imperativo que lleves un proceso de tomar screenshot a la app en funcionamiento y 'mires' la GUI para que entiendas si el diseño es amigable para usar en formatos y resoluciones de pantalla de móvil.

No te detengas hasta que todas las funcionalidades estén completas y probadas. Es posible que la cuota de tokens se agote, de suceder eso, dejaré que se recargue para que continues. En caso de dentener el proceso o haya una falla de conexión al Internet, te diré lo sucedido y te pediré que continues.

Cuando todo lo anterior esté terminado completamente. Escribe el fichero CLAUDE.md correspondiente.
```
