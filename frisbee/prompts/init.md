Prompt used to create this application:

```md
Crea un directorio llamado 'frisbee'. Crearas una aplicación web ahí dentro.

Utiliza unicamente los lenguages HTML, CSS, JavaScript y Python. No instales ninguna libreria. La aplicación debe funcionar unicamente con Python y nada más. Manten el código en una versión que funcione con Python v2 y v3 sin problemas. Utiliza Python para el servidor obviamente. Utiliza HTML, CSS y JavaScript para la GUI. Todo el proceso debe poder ejecutarse desde una sola ejecución de Python (para otras tareas asincronas o adicionales, si lo ves apropiado, puedes agregar otros scripts Python que se ejecuten por CLI). La app debe ser compatible de ejecutarse en Linux y en Windows sin problemas.

Habla conmigo en el chat en español unicamente. El código y documentación escribelo en inglés unicamente.

Manten la GUI de la aplicación sumamente simple y sin muchos estilos CSS. Debe ser responsive para usar en desktop, tablet y movil. Utiliza CSS casi exclusivamente para el control responsive. Agrega un modo oscuro y claro. Manten el modo oscuro como el default.

La aplicación web que debes hacer es un directorio en web navegable. Es decir, al ingresar a la raiz del directorio web (ejemplo http://localhost:8080/), se mostrara un directorio que lista todos los ficheros y directorios ahí contenidos. A esa vista de trabajo la llamaremos Workspace.

Al dar clic en un directorio, se abre y muestra el contenido ahí dentro. Si hay más directorios, se puede seguir navegando dentro del arbol de directorios.

Al estar posicionados en la vista de un directorio y sus contenidos. Las columnas de información muestran el peso de los ficheros, fecha de creación (si está disponible) y cuantos ficheros hay dentro de un directorio. Podemos renombrar cualquier fichero o directorio. Podemos eliminar ficheros o directorios. Podemos subir nuevos directorios o ficheros. Hay una columna de selección multiple donde podemos seleccionar uno o varios directorios o ficheros; con esa selección podemos descargar los seleccionados como un .zip o eliminarlos (al hacer clic en eliminar, pregunta si el usuario está seguro). También es posible mover la selección de ficheros a una nueva ruta (se debe mostrar una barra de progreso mientras se mueven los ficheros).

Cuando se haga un clic en un fichero, hay diferentes comportamientos que se muestran. Si es un fichero de texto, por ejemplo .txt, .md, .json; al hacer clic en él, podemos visualizar el contenido, editarlo o descargar el fichero. Cuando sea un binario, un .exe, .msi, .appimage; simplemente se mostraria un banner que dice que este fichero es un binario y ofrece un botón para descargarlo. Si el fichero es una imagen, muestra una vista previa de la imagen.

Al ingresar a la aplicación web, se le pregunta al usuario la raíz de directorios a utilizar como workspace. Hay tres opciones disponibles.

La primera opción de workspace el directorio virtual alojado dentro del pwd en que se encuentra la aplicación. Es decir, utilizaría un directorio en la ruta relativa al `workspace/`. Hará uso de todo el file system en esa ruta al seleccionar esa opción.

La segunda opción corresponde a utilizar una ruta absoluta que el usuario escribe. Por ejemplo: `/home/user/Documensts/` (en Linux). El sistema verifica si puede listar y leer esa ruta antes de dar paso al workspace.

La tercera opción corresponde a utilizar la raíz del host. En Linux: `/`, en Windows: `c:/`. Si esta opción es seleccionada, verifica antes si hay acceso a esa ruta y se puede listar lo que hay ahí antes de pasar al workspace.

La segunda vista que tiene la aplicación se llamara notepad. Es una ventana que permite crear notas virtuales, leerlas, editarlas y borrarlas en todo momento (antes de entrar en un workspace o dentro de un workspace).

Las notas creadas en el notepad se guardan fisicamente en el disco el pwd del proyecto en `notepad/<nombre-de-nota>.txt`.

Es imperativo que el notepad pueda ser accesible en cualquier momento.

El objetivo de la aplicación es acceder ficheros entre diferentes dispositivos sin complicación. No hay uso de contraseñas, usuarios o limitaciones. Pretende ser un puente HTTP entre dispositivos para compartir ficheros entre si con minima configuracion y fricción. De ahí que solamente deba estar instalado Python en uno de los dos hosts para administrar archivos en ese host.

Todo el código debes escribirlo de forma escalable y versatil. De forma que cambios y nuevas caracteristicas puedan ser agregadas como si se agregaran o quitaran piesas de lego. Escribe comentarios descriptivos que expliquen la funcionalidad del código de forma clara para otras IA.

No pares hasta que todos los puntos esten realizados.

Si necesitas realizar pruebas, utiliza los recursos disponibles en este host.

Cuando termines todo, escribe el fichero AGENTS.md con todo lo relevante. Escribelo tomando en cuenta que Codex, Claude Code o cualquier otra IA va a leerlo para realizar cambios en el código.
```

Second prompt used right after the previous task finished. Some adjustments and additional functions:

```md
Hay unos cuantos cambios a realizar.

1) Si el fichero listado es una imagen o un video, muestra una pequeña vista previa de este. Agrega un checkbox arriba, donde estan los botones Refresh, New Folder, Upload Files, Upload Folder; desmarcado por defecto para hacer toggle de la vista previa de imagenes y videos.

2) Agrega otro checkbox al lado del checkbox del punto 1 para ocultar y mostrar carpetas ocultas de Linux. Es decir, aquellas que comienzan con `.` en el nombre. Marcado por defecto/ocultando los directorios por defecto.

3) Los videos se muestran como binarios que sólo pueden descargarse. Haz una vista previa y reproducción que utilize los recursos del browser para visualizar el video. Exactamente igual que al dar clic en un fichero de tipo imagen.

4) Agrega un buscador que funcione en el la vista de directorio actual. Al escribir en él, automaticamente aplica el filtro de busqueda. El input de busqueda se limpia automaticamente al cambiar de vista de directorio. Al hacer clic en un fichero y volver atrás al mismo directorio donde se aplicó el filtro mantiene la busqueda realizada en el input. El filtro de busqueda afecta a los nombres de ficheros y directorios en la vista de directorio actual y no es sensible a mayusculas.

No pares hasta que lo 4 puntos estén completos y funcionando correctamente.

Cuando termines, documenta estos cambios realizados en el fichero AGENTS.md como corresponda.
```

Third prompt to fix an issue with http port:

```
Hay una falla minima. Si el puerto 8080 está en uso, la app no comienza (eso dice el agente adicional). Por lo que agrega la funcionalidad de que, si el puerto 8080 está en uso, que automaticamente tome el 8081. Si el 8081 también está en uso, entonces 8082. Aumentando 1 hasta encontrar uno libre.

Documenta AGENTS.md y README.md correspondiente con esta caracteristica.
```
