This prompt was the original I, the developer, wrote
to create the application. However, I used Claude Opus
5.5 + Max to rewrote it into a more narrative accurate,
less redundant and cleaner version.

The actual init prompt can be found at [`./init.md`](./init.md)

```
Crea el directorio reptile, vas a crear una app NodeJS ahí dentro.

La app NodeJS es un servidor web con una única libreria externa: chokidar. Toda la interfaz grafica de usuario debes construirla utilizando únicamente HTML, CSS y JavaScript.

La app que vas a construir es una herramienta de sincronización sobre HTTP y HTTPS. Al ejecutar `npm start -- --http` o `npm start -- --https` se ejecutará en HTTP o HTTPS según corresponda. También debe estar presente la flag `--port <puerto>` donde si se coloca `--port 8080` y 8080 está en uso, hará uso de 8081. Si también está en uso, usará 8082 hasta encontrar un puerto libre. El puerto por defecto que la app siempre usara es 556677.

Al elegir HTTPS, se debe generar un certificado autofirmado en el pwd del proyecto en `cert/`. Cada vez que la app se vuelva a iniciar en HTTPS, se genera un nuevo certificado.

Bien, como dije, la herramienta sincroniza directorios y ficheros entre dos computadoras. Muy parecido a como lo hace Syncthing (busca en Internet sobre Syncthing si te hace falta).

La aplicación no tiene persistencia de ningun tipo entre diferentes ejecuciones del proceso. Todo se guarda en la memoria de la app y se pierde al terminar el proceso.

1. Al iniciar la aplicación.

Cuando se inicia la aplicación, en la barra de estado el nombre del host y un codigo UUIDv4 unico de la sesión. Por debajo, la aplicación escanea la red para encontrar otras instancias de 'reptile' ejecutandose. Para ello, es entonces necesario que haya un endpoint HTTP tipo Ping-Pong que el sistema busca para encontrar otra instancia en la red.

Se muestra también en la barra de estado la IP en la red local del dispositivo y el puerto en uso.

Las acciones que puede realizar el usuario al ingresar por primera vez, son un total de dos: Hospedar Directorio y Sincronizar Directorio.

1.1 Hospedar Directorio.

Al hacer clic en Hospedar Directorio, el usuario podra elegir un directorio dando el Absolute Path del directorio.

Al escribirlo en el formulario, el sistema automaticamente verifica que esa ruta exista y se pueda leer el contenido.

Se le puede colocar un nombre a ese directorio a hospedar. Ese campo es opcional, de no darse se le da el nombre que el directorio ya tiene.

La unica seguridad aplicada es un PIN de 4 digitos. Sí, inseguro, pero es sólo una pequeña contraseña simbolica. No hay limite de intentos. El PIN se genera automaticamente por el sistema, pero el usuario puede cambiarlo en cualquier momento. Incluso cuando el directorio ya está siendo hospedado.

Hay una opción avanzada de hospedar sumamente importante, esta se activa cuando se verificó que el directorio proporcionado existe y se puede leer: se muestra una lista de todos los ficheros y directorios (los directorios además se muestran en un arbol) en donde hay un checkbox al inicio. Por defecto todo está marcado. Este checkbox establece que el fichero o directorio será compartido para la instancia que sincroniza el directorio. Es decir, si un directorio tiene 5 ficheros y se desmarcan 3, solamente 2 serán compartidos hacia la instancia que sincroniza.

En este punto, el usuario puede verificar el directorio para ser hospedado. Si todo es correcto y hace clic en hospedar, el usuario es regresado al inicio y ahora sólo podrá cancelar el hosteo para volver a hospedar un directorio diferente o cambiar a Sincronizar un directorio. Si el usuario quiere hospedar varios directorios, debe iniciar otro proceso de 'reptile'. Puede cambiar el PIN en este estado también.

1.2 Sincronizar Directorio.

Esta opción es la de recibir los datos de un directorio hospedado en otra instancia en la red.

Como mencioné la herramienta está escaneando la red por otras instancias de reptile. Por lo que si encontró una y esta resulta que esta hospedando un directorio, con un clic, se conectaría a esta conexión. Claro, después de ingresar el PIN de forma correcta.

En caso de que reptile no haya detectado la otra instancia de reptile hospedando un directorio, el usuario puede optar por dar la dirección IP y puerto para encontrar esa instancia y verificar si tiene el directorio hospedado. Se conectaría, nuevamente, después de agregar el PIN correctamente.

Si la instancia ya está conectada y el host que hospeda el directorio cambia el PIN, la conexión es terminada inmediatamente y continuaría cuando la instancia sincronizada escriba el PIN.

2. Caracteristicas adicionales de Sincronización.

La sincronización es en tiempo real. Ya sea el hospedado o sincronizado que haga un cambio, se verá reflejado en la otra instancia tan pronto sea posible.

No pueden haber multi-instancias conectadas a un mismo directorio conectado. Sólo es permitida la conexión 1 a 1. 

Una instancia HTTP o HTTPS solo puede conectarse a otra instancia con el mismo HTTP o HTTPS.

---

No pares hasta que todos los puntos, caracteristicas y funcionalidades estén programados y probados. Haz uso del host actual Linux Mint con NodeJS instalado para hacer todo lo que necesites durante el desarrollo y pruebas.
```
