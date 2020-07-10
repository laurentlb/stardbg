let pausedThreads = new Map;
var selectedThread = 0;
var selectedFile = "";
var selectedLine = null;
var editor = null;
var breakpoints = [];

function init(ed) {
  editor = ed;
}

function unselectThread() {
  if (selectedThread == 0) {
    return;
  }
  document.getElementById("status").textContent = "Running";
}

function selectThread(id) {
  selectedThread = id;
  sendRequest({listFrames: {threadId: id}});

  var thread = pausedThreads.get(id);
  loadFile(thread.location.path, thread.location.lineNumber, true);
  document.getElementById("status").textContent = "Debugging " + thread.name;
}

function loadFile(file, line, highlight) {
  if (highlight && selectedLine != null) {
    editor.removeLineClass(selectedLine - 1, "background", "selected-line");
  }

  var updateUI = function() {
    var thread = pausedThreads.get(selectedThread);

    if (highlight) {
      editor.addLineClass(line - 1, "background", "selected-line");
      selectedLine = line;
    }
    editor.scrollIntoView({line: line - 1}, 100);

    breakpoints.forEach(bp => {
      if (bp.location.path === file) {
        addBreakpointDiv(bp.location.lineNumber - 1);
      }
    });
  };

  var updateContent = function(content, filename) {
    selectedFile = file;
    editor.setValue(content);

    // file name at the top
    var marker = document.createElement("div");
    marker.innerHTML = filename;
    editor.addLineWidget(0, marker, {above: true, className: "line-widget"});
  };

  if (selectedFile != file) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/file' + file);

    xhr.onreadystatechange = function () {
      var DONE = 4; // readyState 4 means the request is done.
      var OK = 200; // status 200 is a successful return.

      if (xhr.readyState === DONE) {
        if (xhr.status === OK) {
          updateContent(xhr.responseText, file);
          updateUI();
        } else {
	  console.log('Error: ' + xhr.status);
        }
      }
    };

    xhr.send(null);
  } else {
    updateUI();
  }
}

var refreshTimer = null;

function refreshThreadList() {
  var tbody = document.getElementById('threads-body');
  tbody.innerHTML = '';

  // Instead of recreating the DOM immediately, we wait a bit in case there are
  // other events updating pausedThreads.
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function() {
    pausedThreads.forEach((thread, id) => {
      var row = tbody.insertRow(0);
      var button = document.createElement("a");
      button.textContent = thread.id;
      button.onclick = function() { selectThread(thread.id); };
      button.href = "#";

      row.insertCell().appendChild(button);
      row.insertCell().textContent = thread.location.path;
      row.insertCell().textContent = thread.location.lineNumber;
      row.insertCell().textContent = thread.name;
      row.insertCell().textContent = thread.pauseReason;
    })
  }, 5);
}

function threadPausedEvent(th) {
  pausedThreads.set(th.id, th);
  refreshThreadList();

  // If another paused thread is selected, don't update the view.
  if (selectedThread == th.id || !pausedThreads.has(selectedThread)) {
    selectThread(th.id);
  }
}

function listFramesEvent(frames) {
  // Update the call stack
  var tbody = document.getElementById('stack-body');
  tbody.innerHTML = '';

  frames.forEach(frame => {
    var row = tbody.insertRow();
    var button = document.createElement("a");
    button.textContent = frame.functionName;
    button.onclick = function() { loadFile(frame.location.path, frame.location.lineNumber, true); };
    button.href = "#";

    row.insertCell().appendChild(button);
    row.insertCell().textContent = frame.location.path;
    row.insertCell().textContent = frame.location.lineNumber;
  });

  // Update the locals
  tbody = document.getElementById('locals-body');
  tbody.innerHTML = '';

  frame = frames[0];
  frame.scope.forEach(scope => {
    if (scope.binding) {
      scope.binding.forEach(binding => {
        var row = tbody.insertRow();
        row.insertCell().textContent = binding.label;
        row.insertCell().textContent = binding.description;
        row.insertCell().textContent = binding.type;
      });
    }
  });
}

function setBreakpointsEvent(e) {
  if (e == null) {
    return;
  }

  breakpoints = e;
  console.log("bps", e);
  sendRequest({setBreakpoints: {breakpoint: e}});

  tbody = document.getElementById('breakpoints-body');
  tbody.innerHTML = '';

  breakpoints.forEach(bp => {
    var row = tbody.insertRow();
    var button = document.createElement("a");
    button.textContent = bp.location.path;
    button.onclick = function() { loadFile(bp.location.path, bp.location.lineNumber, false); };
    button.href = "#";

    row.insertCell().appendChild(button);
    row.insertCell().textContent = bp.location.lineNumber;
    row.insertCell(); // TODO(laurentlb): Conditional breakpoints.
  });
}

function handleEvent(e) {
  if (e.hasOwnProperty("threadPaused")) {
    threadPausedEvent(e.threadPaused.thread);
  } else if (e.hasOwnProperty("listFrames")) {
    listFramesEvent(e.listFrames.frame);
  } else if (e.hasOwnProperty("setBreakpoints")) {
    setBreakpointsEvent(e.setBreakpoints.breakpoint);
  } else {
    console.log("other", e);
  }
  // else if (Array.isArray(e)) {
  //   breakpoints = e;
  // }
}

function listenEvents() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/updates');

  // Track the state changes of the request.
  xhr.onreadystatechange = function () {
    var DONE = 4; // readyState 4 means the request is done.
    var OK = 200; // status 200 is a successful return.

    if (xhr.readyState === DONE) {
      if (xhr.status === OK) {
        handleEvent(JSON.parse(xhr.responseText));
        return listenEvents();
      } else {
	console.log('Error: ' + xhr.status);
        document.getElementById("status").textContent = "Connection closed.";
      }
    }
  };

  xhr.send(null);
}

function sendRequest(data) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", "/request");
  xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
  xhr.send(JSON.stringify(data));
}

function stepButton(stepping) {
  if (stepping == null) { // resume all
    pausedThreads.clear();
    selectedThread = 0;
  } else {
    pausedThreads.delete(selectedThread);
  }

  sendRequest({
    continueExecution: {
      threadId: selectedThread,
      stepping: stepping
  }});
  if (selectedLine != null) {
    editor.removeLineClass(selectedLine - 1, "background", "selected-line");
  }
  refreshThreadList();
}

function stopAllButton() {
  sendRequest({pauseThread: {threadId: 0}});
}

function addBreakpointDiv(n) {
  var info = editor.lineInfo(n);
  if (info.gutterMarkers) {
    return;
  }
  var marker = document.createElement("div");
  marker.classList.add("breakpoint");
  marker.innerHTML = "●";
  editor.setGutterMarker(n, "breakpoints", marker);
}

function breakpointClick(cm, n) {
  var info = cm.lineInfo(n);
  if (info.gutterMarkers) {
    breakpoints = breakpoints.filter(
        bp => bp.location.path != selectedFile || bp.location.lineNumber != n + 1);
    sendRequest({setBreakpoints: {breakpoint: breakpoints}});
    editor.setGutterMarker(n, "breakpoints", null);
  } else {
    var loc = {location: {path: selectedFile, lineNumber: n + 1}};
    breakpoints.push(loc);
    addBreakpointDiv(n);
  }
  setBreakpointsEvent(breakpoints);
}
