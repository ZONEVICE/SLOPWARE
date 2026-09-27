The live maintenance guide for this application is [`../CLAUDE.md`](../CLAUDE.md). This file only keeps the original prompt, as history: it is not a specification to re-execute.

Prompt used to create this application:

```
# Detalles tecnicos

Crea el directorio lurker, vas a crear una aplicación web ahí.

Debes utilizar Python para programar el servidor web. Utiliza unicamente HTML, CSS y JavaScript para crear la GUI. No debes instalar ninguna libreria, utiliza unicamente la Standard Library de Python.

Al ejecutar el servidor, se pueden pasar ciertos parametros. 

El parametro `http` o `https` para especificar que el servidor se va a ejecutar como http o https. Por defecto, siempre se ejecuta por HTTPS. El certificado HTTPS es autofirmado y generado cada vez que la app se ejecuta. Es decir, reemplaza siempre el certificado anterior, de haberlo. El certicado se guarda en el pwd de la app en `cert/`.

El parametro `port <numero>` para especificar el puerto de apertura de la app. Por defecto, abre el puerto 8080. Si esta en uso, la app automaticamente detecta 8081 > 8082 > 8083; hasta encontrar un puerto disponible.

El parametro `dir <ruta absoluta>` establece automaticamente donde la aplicación va a leer los ficheros y directorios del file system. Más adelante para qué se usa esa ruta.

El parametro `pass <contraseña>` define la contraseña automaticamente. Ingresarla hará que el usuario que se conecte donde la app web está siendo servida se le solicite la contraseña. De otro modo, todos los endpoints y llamadas de API estarán bloqueados.

La aplicación no tiene persistencia de ningun tipo. Ni base de datos ni estado en un `.json`. Todo es conservado en memoria y borrado al detener el proceso.

El icono de la app debe ser un ojo. Dibujalo como SVG.

# Qué es Lurker

Lurker es una aplicación web para visualizar imagenes y videos en una rejilla que toma la mayor parte del viewport.

Puede filtrar por videos e imagenes. Filtros avanzados filtran por tipo de imagen o video, fecha de creacion, peso, etc.

La aplicación recibe una ruta absoluta hacia un directorio. En ese directorio, lee las imagenes y videos que ahí se encuentran. Además, revisa de forma recursiva el árbol completo de subdirectorios en esa ruta y registra todos los elementos de imagen y video que ahí se encuentren. Muestra en una sola rejilla de galería todos los ficheros de imagen y video encontrados.

Hay diferentes formas de representar los ficheros multimedia. Por ejemplo, al dar clic en una imagen o video, esta se expande con controles especificos para hacer zoom, descargar, reproducir, etc.

Hay otras formas de visualización además de la rejilla tipo album. Puede también visualizarse por directorio, arbol de directorios, etc. Haz las visualizaciones que quieras, pero manten la rejilla de vista total indiscriminada como la vista por defecto una vez se ha leido el directorio dado.

# Uso de la app

Al ejecutar la app y un usuario ingresar a la IP:puerto donde esta se aloja, se le preguntará al usuario la ruta absoluta para iniciar la busqueda y posterior presentación de imagenes y videos que ahí y en subdirectorios se encuentre. Antes de verificar el directorio dado, el sistema verifica si la ruta es valida y puede leerla. Si la ruta absoluta ya fue proporcionada por el parametro en el CLI, se salta este paso. Eso asumiendo que es una ruta valida y que se puede leer, de lo contrario, se muestra el formulario inicial preguntando por la ruta absoluta.

Al dar clic en aceptar la ruta absoluta, se pasa a mostrar todos los directorios. Si otro usuario se conecta a la URL de Lurker, verá el album de rejilla ya establecido. Si hay contraseña definida, este usuario debe ingresarla al venir desde otra IP/OS.

El usuario en cualquier momento puede cerrar el album. Al hacer eso, se le preguntará nuevamente una ruta absoluta para ver otro album. Si el usuario quiere diferentes álbumes abiertos, debe iniciar otras instancias de Lurker.

# Instrucciones finales

No te detengas hasta que todos los puntos, funcionalidades y pruebas correspondientes hayan terminado.

Utiliza los recursos del host actual para lo que necesites para realizar las pruebas.
```
