/* @requires
mapshaper-zip-reader
mapshaper-progress-message
mapshaper-gui-options
*/

// tests if filename is a type that can be used
gui.isReadableFileType = function(filename) {
  var ext = utils.getFileExtension(filename).toLowerCase();
  return !!internal.guessInputFileType(filename) || internal.couldBeDsvFile(filename) ||
    internal.isZipFile(filename);
};

// @cb function(<FileList>)
function DropControl(cb) {
  var el = El('body');
  el.on('dragleave', ondrag);
  el.on('dragover', ondrag);
  el.on('drop', ondrop);
  function ondrag(e) {
    // blocking drag events enables drop event
    e.preventDefault();
  }
  function ondrop(e) {
    e.preventDefault();
    cb(e.dataTransfer.files);
  }
}

// @el DOM element for select button
// @cb function(<FileList>)
function FileChooser(el, cb) {
  var btn = El(el).on('click', function() {
    input.el.click();
  });
  var input = El('form')
    .addClass('file-control').appendTo('body')
    .newChild('input')
    .attr('type', 'file')
    .attr('multiple', 'multiple')
    .on('change', onchange);

  function onchange(e) {
    var files = e.target.files;
    // files may be undefined (e.g. if user presses 'cancel' after a file has been selected)
    if (files) {
      // disable the button while files are being processed
      btn.addClass('selected');
      input.attr('disabled', true);
      cb(files);
      btn.removeClass('selected');
      input.attr('disabled', false);
    }
  }
}

function ImportControl(model, opts) {
  var importCount = 0;
  var queuedFiles = [];
  var manifestFiles = opts.files || [];
  var importDataset;

  new SimpleButton('#import-buttons .submit-btn').on('click', submitFiles);
  new SimpleButton('#import-buttons .cancel-btn').on('click', gui.clearMode);
  gui.addMode('import', turnOn, turnOff);
  new DropControl(receiveFiles);
  new FileChooser('#file-selection-btn', receiveFiles);
  new FileChooser('#import-buttons .add-btn', receiveFiles);
  new FileChooser('#add-file-btn', receiveFiles);
  gui.enterMode('import');
  gui.on('mode', function(e) {
    // re-open import opts if leaving alert or console modes and nothing has been imported yet
    if (!e.name && importCount === 0) {
      gui.enterMode('import');
    }
  });

  function findMatchingShp(filename) {
    // use case-insensitive matching
    var base = utils.getPathBase(filename).toLowerCase();
    return model.getDatasets().filter(function(d) {
      var fname = d.info.input_files && d.info.input_files[0] || "";
      var ext = utils.getFileExtension(fname).toLowerCase();
      var base2 = utils.getPathBase(fname).toLowerCase();
      return base == base2 && ext == 'shp';
    });
  }

  function turnOn() {
    var el = El('#import-options');
    if (manifestFiles.length > 0) {
      downloadFiles(manifestFiles);
      manifestFiles = [];
    } else {
      if (importCount > 0) {
        el.removeClass('first-run');
      } else {
        El('#fork-me').show();
      }
      el.show();
    }
  }

  function turnOff() {
    if (importDataset) {
      // display first layer of most recently imported dataset
      model.selectLayer(importDataset.layers[0], importDataset);
      importDataset = null;
    }
    gui.clearProgressMessage();
    clearFiles();
    close();
  }

  function close() {
    El('#fork-me').hide();
    El('#import-options').hide();
  }


  function clearFiles() {
    queuedFiles = [];
    El('#dropped-file-list .file-list').empty();
    El('#dropped-file-list').hide();
    El('#import-buttons').hide();
  }

  function addFiles(files) {
    var index = {};
    queuedFiles = queuedFiles.concat(files).reduce(function(memo, f) {
      // filter out unreadable types and dupes
      if (gui.isReadableFileType(f.name) && f.name in index === false) {
        index[f.name] = true;
        memo.push(f);
      }
      return memo;
    }, []);
    // sort alphabetically by filename
    queuedFiles.sort(function(a, b) {
      // Sorting on LC filename is a kludge, so Shapefiles with mixed-case
      // extensions are sorted with .shp component before .dbf
      // (When .dbf files are queued first, they are imported as a separate layer.
      // This is so data layers are not later converted into shape layers,
      // e.g. to allow joining a shape layer to its own dbf data table).
      return a.name.toLowerCase() > b.name.toLowerCase() ? 1 : -1;
    });
  }

  function showQueuedFiles() {
    var list = El('#dropped-file-list .file-list').empty();
    El('#dropped-file-list').show();
    queuedFiles.forEach(function(f) {
      El('<p>').text(f.name).appendTo(El("#dropped-file-list .file-list"));
    });
  }

  function receiveFiles(files) {
    var prevSize = queuedFiles.length;
    addFiles(utils.toArray(files));
    if (queuedFiles.length === 0) return;
    gui.enterMode('import');
    if (importCount === 0 && prevSize === 0 && containsImmediateFile(queuedFiles)) {
      // if the first batch of files will be imported, process right away
      submitFiles();
    } else {
      showQueuedFiles();
      El('#import-buttons').show();
    }
  }

  // Check if an array of File objects contains a file that should be imported right away
  function containsImmediateFile(files) {
    return utils.some(files, function(f) {
        var type = internal.guessInputFileType(f.name);
        return type == 'shp' || type == 'json';
    });
  }

  function submitFiles() {
    close();
    readNext();
  }

  function readNext() {
    if (queuedFiles.length > 0) {
      readFile(queuedFiles.pop()); // read in rev. alphabetic order, so .shp comes before .dbf
    } else {
      gui.clearMode();
    }
  }

  function getImportOpts() {
    var freeform = El('#import-options .advanced-options').node().value,
        opts = gui.parseFreeformOptions(freeform, 'i');
    opts.no_repair = !El("#repair-intersections-opt").node().checked;
    opts.auto_snap = !!El("#snap-points-opt").node().checked;
    return opts;
  }

  function readSingleFile(file) {
    var name = file.name,
        reader = new FileReader(),
        useBinary = internal.isBinaryFile(name) ||
          internal.guessInputFileType(name) == 'json' ||
          internal.guessInputFileType(name) == 'text';

    reader.addEventListener('loadend', function(e) {
      if (!reader.result) {
        handleImportError("Web browser was unable to load the file.", name);
      } else {
        readFileContent(name, reader.result);
      }
    });
    if (useBinary) {
      reader.readAsArrayBuffer(file);
    } else {
      // TODO: improve to handle encodings, etc.
      reader.readAsText(file, 'UTF-8');
    }
  }

  // @file a File object
  function readFile(file) {
    if (internal.isZipFile(file.name)) {
      readZipFile(file);
    } else {
      readSingleFile(file);
    }
  }

  function readFileContent(name, content) {
    var type = internal.guessInputType(name, content),
        importOpts = getImportOpts(),
        matches = findMatchingShp(name),
        dataset, lyr;

    // TODO: refactor
    if (type == 'dbf' && matches.length > 0) {
      // find an imported .shp layer that is missing attribute data
      // (if multiple matches, try to use the most recently imported one)
      dataset = matches.reduce(function(memo, d) {
        if (!d.layers[0].data) {
          memo = d;
        }
        return memo;
      }, null);
      if (dataset) {
        lyr = dataset.layers[0];
        lyr.data = new internal.ShapefileTable(content, importOpts.encoding);
        if (lyr.shapes && lyr.data.size() != lyr.shapes.length) {
          stop("Different number of records in .shp and .dbf files");
        }
        if (!lyr.geometry_type) {
          // kludge: trigger display of table cells if .shp has null geometry
          model.updated({}, lyr, dataset);
        }
        readNext();
        return;
      }
    }

    if (type == 'prj') {
      // assumes that .shp has been imported first
      matches.forEach(function(d) {
        if (!d.info.prj) {
          d.info.prj = content;
        }
      });
      readNext();
      return;
    }

    importFileContent(type, name, content, importOpts);
  }

  function importFileContent(type, path, content, importOpts) {
    var size = content.byteLength || content.length, // ArrayBuffer or string
        showMsg = size > 4e7, // don't show message if dataset is small
        delay = 0;

    importOpts.files = [path]; // TODO: try to remove this
    if (showMsg) {
      gui.showProgressMessage('Importing');
      delay = 35;
    }
    setTimeout(function() {
      var dataset;
      try {
        dataset = internal.importFileContent(content, path, importOpts);
        dataset.info.no_repair = importOpts.no_repair;
        model.addDataset(dataset);
        importDataset = dataset;
        importCount++;
        readNext();
      } catch(e) {
        handleImportError(e, path);
      }
    }, delay);
  }

  function handleImportError(e, path) {
    var msg = utils.isString(e) ? e : e.message;
    if (path) {
      msg = "Error importing <i>" + path + "</i><br>" + msg;
    }
    clearFiles();
    gui.alert(msg);
    console.error(e);
  }

  function readZipFile(file) {
    gui.showProgressMessage('Importing');
    setTimeout(function() {
      gui.readZipFile(file, function(err, files) {
        if (err) {
          handleImportError(err, file.name);
        } else {
          // don't try to import .txt files from zip files
          // (these would be parsed as dsv and throw errows)
          files = files.filter(function(f) {
            return !/\.txt$/i.test(f.name);
          });
          addFiles(files);
          readNext();
        }
      });
    }, 35);
  }

  function prepFilesForDownload(names) {
    var items = names.map(function(name) {
      var isUrl = /:\/\//.test(name);
      var item = {name: name};
      if (isUrl) {
        item.url = name;
        item.basename = gui.getUrlFilename(name);
      } else {
        item.basename = name;
        // Assume non-urls are local files loaded via mapshaper-gui
        item.url = '/data/' + name;
      }
      return gui.isReadableFileType(item.basename) ? item : null;
    });
    return items.filter(Boolean);
  }

  function downloadFiles(paths, opts) {
    var items = prepFilesForDownload(paths);
    utils.reduceAsync(items, [], downloadNextFile, function(err, files) {
      if (err) {
        gui.alert(err);
      } else if (!files.length) {
        gui.clearMode();
      } else {
        addFiles(files);
        submitFiles();
      }
    });
  }

  function downloadNextFile(memo, item, next) {
    var req = new XMLHttpRequest();
    var blob;
    req.responseType = 'blob';
    req.addEventListener('load', function(e) {
      if (req.status == 200) {
        blob = req.response;
      }
    });
    req.addEventListener('loadend', function() {
      var err;
      if (req.status == 404) {
        err = "Not&nbsp;found:&nbsp;" + item.name;
      } else if (!blob) {
        // Errors like DNS lookup failure, no CORS headers, no network connection
        // all are status 0 - it seems impossible to show a more specific message
        // actual reason is displayed on the console
        err = "Error&nbsp;loading&nbsp;" + item.name + ". Possible causes include: wrong URL, no network connection, server not configured for cross-domain sharing (CORS).";
      } else {
        blob.name = item.basename;
        memo.push(blob);
      }
      next(err, memo);
    });
    req.open('GET', item.url);
    req.send();
  }
}
