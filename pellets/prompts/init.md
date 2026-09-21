Prompt used to create this application:

```
Crea el directorio pellets. Vas a crear una aplicación web ahí.

La aplicación va a hacer uso de NodeJS y la librería del ecosistema npm llamada `ws` para el backend. Para toda la GUI o frontend utiliza unicamente HTML, CSS y JavaScript y es servida por el backend. Es decir, todo se ejecuta en un sólo proceso NodeJS. No debes utilizar ninguna otra libreria en ninguna otra capa que no sea `ws` en el backend.

La aplicación que vas a construir es un chat en tiempo real. Utiliza la libreria `ws` en el backend para facilitarte la programación.

La aplicación utiliza npm como gestor de paquetes y de inicio. Es decir, se inicializaría ejecutando `npm start`.

El backend no tiene persistencia en disco. Ni base de datos ni datos en un JSON que se escribe en disco. Todos los datos de chats, usuarios y sesiones se mantienen vivas en la memoria. Al cerrar el proceso de la aplicación, todo es borrado.

La GUI debe ser responsive para que se muestre correctamente en desktop, tablet o movil. Debe tener modo claro y oscuro. Por defecto debe estar en modo oscuro. 

Al ingresar en la raíz de la aplicación web, el servidor automaticamente lee el Client Metadata para verificar si es usuario nuevo o viejo. De ser nuevo, le asigna un nuevo UUID4 utilizando la libreria interna de NodeJS `crypto` y crea una sesión persistida en la memoria del servidor. De ser un usuario ya conocido, retorna la sesión que el usuario ya tiene. Si un cliente ingresa mediante una URL que va hacía una sala de chat y no tiene sesión, se le presenta un modal o ventana emergente para que primero escoja su nombre de usuario. Elegir el nombre de usuario es siempre el único paso que un cliente debe hacer para utilizar el chat. No hay restricción alguna en el nombre de usuario que un cliente decida utilizar.

Al cliente que acaba de elegir su nombre de usuario, se le asigna un color de forma aleatoria para diferenciarse de los demás usuarios.

El chat debe mostrar un indicador de que un usuario está escribiendo en tiempo real. Los mensajes, una vez enviados, deben mostrarse a los demás usuarios dentro de la sala de chat.

Si una sala de chat ya tiene mensajes y un usuario ingresa, puede ver todos esos mensajes anteriores a su ingreso a esa sala por primera vez.

En las salas de chat, los usuarios pueden enviar imagenes y videos. Las imagenes automaticamente se muestran en el chat como vista previa y al darles clic se muestran de forma extendida. Los vídeos se muestran con su vista previa también, al hacer clic, se extiende y se reproduce usando las herramientas del browser. Si el fichero es otro tipo de binario que no sea imagen o video, se muestra el nombre del fichero y su extensión. Hacer clic en un binario automaticamente lo descarga. Todos estos ficheros se guardan en el pwd de la aplicación en el directorio `uploads/`. Los ficheros ahí guardados son persistidos al cerrar la aplicación. Naturalmente el backend puede leerlos, pero no los listará en ningun lado al no existir un chat relacionado a esos ficheros.

La aplicación tiene 3 ventanas principales.

1) La ventana Home. Esta muestra una lista con las salas de chat disponibles y cuantos usuarios hay conectados a ella. En esta ventana, los usuarios pueden crear nuevas salas de chat. No hay limite para ello. Una sala de chat, aunque no tenga ningun usuario, sigue abierta y en la lista de salas disponibles.

2) Ventana de sala de chat. Aquí es donde los usuarios envian los mensajes. Los usuarios no pueden editar ni eliminar mensajes ya enviados. Sólo el creador original de una sala de chat puede eliminar esa sala de chat.

3) Configuración. Ventana muy simple donde el cliente puede cambiar su nombre de usuario (su UUID4 se mantiene y no puede cambiarse), el color de su usuario o cambiar a modo claro/oscuro.

La aplicación debe ser capaz de funcionar sobre HTTP y HTTPS. Al ejecutar la aplicación como `npm start` o `npm start -- --http`, la aplicación se ejecutaría sobre HTTP. Al ejecutarla como `npm start -- --https`; el proceso primero crearia por si mismo un nuevo certificado SSL autofirmado, se lo auto-establece y entonces ejecuta la aplicación haciendo uso de HTTPS. El certificado puedes guardarlo en el pwd de la aplicacion en `cert/`. Y sí, entre cada nueva ejecución de la aplicación, aunque ya haya un certificado en `cert/`, se debe crear uno nuevo y usar ese. Las conexiones websocket correran en `ws://` o `wss://` segun corresponda.

No pares hasta que todos los puntos, caracteristicas y funcionalidades esten implementadas y terminadas. Crea tests para corroborar que todo funciona. Sientete libre de usar los recursos del sistema operativo host actual para lo que necesites ejecutar.

Es imperativo que escribas comentarios en el código para que sea comprensible para otros agentes de IA, ya sea Claude Code, Codex o cualquier otra.

El código debe ser escalable, versatil y modular. De modo que las caracteristicas puedan ser acopladas o desacopladas facilmente como piezas de lego para asegurar nuevas funciones que puedan colocarse en el medio sin dificultad.

Cuando hayas terminado todo lo anterior, finaliza escribiendo el fichero CLAUDE.md con todo lo relevante del proyecto para otras sesiones de Claude Code, Codex, u otra IA similar.

```

Second prompt to fix used port problem.

```
Excelente. Sólo un cambio a realizar.

Si se ejecuta `npm start` y el puerto 8080 está en uso, automaticamente toma 8081. Si 8081 también está en uso, intenta 8082. Sigue sumando en 1 hasta encontrar un puerto libre.

Ese comportamiento también sucede si se ejecuta `npm start -- --port 8080` y el puerto está ya en uso.
```
