The live maintenance guide for this application is [`../CLAUDE.md`](../CLAUDE.md). This file only keeps the original prompt, as history: it is not a specification to re-execute.

Prompt used to create this application:

```
# Reptile: sincronización de directorios entre dos computadoras

Crea el directorio `reptile` y, dentro de él, una aplicación Node.js.

## Qué es Reptile

Reptile sincroniza un directorio entre dos computadoras de la misma red local, sobre HTTP o HTTPS, en tiempo real y en ambas direcciones. Se parece a Syncthing (búscalo en Internet si necesitas referencia), pero es mucho más simple: una instancia **hospeda** un directorio y otra instancia se conecta a ella para **sincronizarlo**.

## Restricciones técnicas

- La app es un servidor web en Node.js. La única dependencia externa permitida es `chokidar`. Todo lo demás se resuelve con los módulos nativos de Node.
- La interfaz gráfica se construye únicamente con HTML, CSS y JavaScript puros (sin frameworks ni librerías). La sirve el propio servidor y se usa desde el navegador.
- No hay persistencia de ningún tipo entre ejecuciones. Todo el estado de la app (directorio hospedado, PIN, conexiones, instancias descubiertas) vive en memoria y se pierde al terminar el proceso. Los ficheros sincronizados, por supuesto, sí quedan en disco.

## Arranque

- `npm start -- --http` inicia la app en HTTP y `npm start -- --https` la inicia en HTTPS. Si no se indica ninguna de las dos, usa HTTP.
- `--port <puerto>` define el puerto. Si está en uso, prueba el siguiente (8080 → 8081 → 8082…) hasta encontrar uno libre. Sin esta flag, el puerto por defecto es **55667**, con la misma lógica de búsqueda.
- En HTTPS, genera un certificado autofirmado en `cert/`, dentro del directorio del proyecto. Cada arranque en HTTPS genera un certificado nuevo que reemplaza al anterior. Como no puedes usar librerías externas para esto, usa el `openssl` del sistema.

## Barra de estado

Siempre visible. Muestra el nombre del host, un UUIDv4 único de la sesión (generado al arrancar), la IP del equipo en la red local, el puerto en uso y el protocolo (HTTP o HTTPS).

## Descubrimiento de otras instancias

Desde el arranque, y de forma continua en segundo plano, Reptile escanea la red local buscando otras instancias de Reptile. Para ello, cada instancia expone un endpoint HTTP tipo ping-pong que responde identificándose como Reptile e incluye su hostname, UUID, protocolo y si está hospedando un directorio (y cuál). El escaneo recorre la subred local en el puerto por defecto y en un rango razonable de puertos siguientes (decide tú el rango). La instancia no se muestra a sí misma en la lista. El usuario puede apagar el escaneo automatico con un clic de un botón en la barra de estado.

## Pantalla inicial

La primera vez que el usuario entra, tiene dos acciones: **Hospedar directorio** y **Sincronizar directorio**. Una instancia está siempre en un solo modo a la vez: hospeda, sincroniza o ninguno de los dos.

### Hospedar directorio

1. El usuario escribe la ruta absoluta del directorio. Mientras escribe, el sistema verifica automáticamente que la ruta exista, sea un directorio y su contenido se pueda leer, y muestra el resultado.
2. El usuario puede darle un nombre al directorio hospedado. Es opcional: si lo deja vacío, se usa el nombre que ya tiene el directorio.
3. El sistema genera automáticamente un PIN de 4 dígitos. Es la única seguridad de la app. Sí, es inseguro: es solo una contraseña simbólica. No hay límite de intentos. El usuario puede cambiar el PIN en cualquier momento, incluso mientras el directorio ya se está hospedando.
4. **Selección de contenido (opción avanzada, muy importante).** En cuanto la ruta queda verificada, se muestra el árbol completo de ficheros y directorios, con un checkbox delante de cada elemento. Por defecto todo está marcado. Solo lo marcado se comparte con la instancia que sincroniza. Por ejemplo, si un directorio tiene 5 ficheros y el usuario desmarca 3, solo se comparten 2. Desmarcar un directorio desmarca todo su contenido.
5. Al hacer clic en **Hospedar**, el usuario vuelve a la pantalla inicial. A partir de ahí solo puede cambiar el PIN, cancelar el hospedaje (para hospedar otro directorio) o pasar a sincronizar un directorio (lo que también cancela el hospedaje).

Si el usuario quiere hospedar varios directorios a la vez, debe ejecutar otro proceso de Reptile.

### Sincronizar directorio

Este modo recibe un directorio hospedado por otra instancia de la red.

1. El usuario elige la instancia de una de dos formas:
   - **Automática:** de la lista de instancias descubiertas que están hospedando un directorio, con un clic.
   - **Manual:** si el escaneo no encontró la instancia, el usuario escribe su IP y puerto, y el sistema verifica que ahí haya un Reptile hospedando un directorio.
2. El usuario indica la ruta absoluta local donde se guardará el directorio sincronizado.
3. El usuario introduce el PIN. Si es correcto, se conecta y empieza la sincronización. Si es incorrecto, puede reintentarlo sin límite.

## Reglas de sincronización

- **Tiempo real y bidireccional.** Cualquier cambio en cualquiera de los dos lados (crear, modificar, renombrar o borrar ficheros y directorios) se refleja en el otro lo antes posible. Usa `chokidar` para detectar los cambios.
- **Sincronización inicial.** Al conectarse, se hace una sincronización completa del contenido compartido y, a partir de ahí, se sincronizan los cambios en tiempo real.
- **Solo lo marcado.** Solo se sincroniza lo que el host marcó. Lo desmarcado nunca sale del host y nunca se modifica desde el otro lado.
- **Conexión 1 a 1.** Un directorio hospedado solo admite una instancia conectada. Cualquier otro intento de conexión se rechaza con un mensaje claro.
- **Mismo protocolo.** Una instancia HTTP solo se conecta con otra HTTP, y una HTTPS solo con otra HTTPS. En la lista de descubiertas, las instancias de otro protocolo se muestran como incompatibles. En HTTPS, las conexiones entre instancias deben aceptar el certificado autofirmado de la otra parte.
- **Cambio de PIN con conexión activa.** Si el host cambia el PIN mientras hay una instancia conectada, la conexión se corta de inmediato. La instancia sincronizada ve un aviso y se le pide el nuevo PIN; al introducirlo correctamente, la sincronización se reanuda.
- **Cancelación del hospedaje.** Si el host cancela el hospedaje, la instancia sincronizada se desconecta y recibe un aviso.
- Ambas interfaces muestran en todo momento el estado de la conexión.

## Desarrollo, pruebas y criterio de terminado

Estás en un host Linux Mint con Node.js instalado. Úsalo para todo lo que necesites durante el desarrollo y las pruebas.

Para probar, levanta dos instancias en la misma máquina, con puertos y directorios distintos, tanto en HTTP como en HTTPS. Escribe pruebas automatizadas con `node:test` (sin dependencias adicionales) que cubran, como mínimo: la búsqueda de puerto libre, la generación del certificado, el endpoint ping-pong y el descubrimiento, la validación de rutas, el PIN (correcto, incorrecto y cambio con conexión activa), la selección de contenido, la sincronización en ambas direcciones (crear, modificar, renombrar y borrar), el rechazo de una segunda conexión y el rechazo entre protocolos distintos. Haz todas las demás pruebas que consideres relevantes.

No te detengas hasta que todos los puntos, características y funcionalidades de este documento estén programados y probados.
```
