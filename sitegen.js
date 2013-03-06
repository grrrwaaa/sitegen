#!/usr/local/bin/node

// run as ./sitegen.js from the root directory of the site to be generated / served

// built in
var fs = require('fs');
var http = require('http');

// installed
var express = require('express');
var marked = require('marked');
var hljs = require("highlight.js");
var watch = require("watch");
var props = require("props");
var _ = require('underscore');
var jade = require('jade');
var mustache = require('mustache');
var io = require('socket.io');

// regex for filename extension
var re = /(?:\.([^.]+))?$/;

/// configuration ////

var appdir = __dirname;
var homedir = process.cwd();
var publicdir = homedir; // + '/public';
var srcdir = homedir + '/src';

console.log("serving", homedir);

var marked_options = {
	gfm: true, // github-flavored
	tables: true, // github tables
	breaks: false, // github breaks
	//sanitize: true, // ignore html in the input
	smartLists: true, // smarter than original markdown
	langPrefix: 'lang-',
	highlight: function(code, lang) {
		if (lang) {
			return hljs.highlight(lang, code).value;
		} else {
			return hljs.highlightAuto(code).value;
		}
	}
};
marked.setOptions(marked_options);

var example = "this {{title}} title";
var exampletemplate = mustache.compile(example);

/// server ////

var app = express();
var server = http.createServer(app);

// Bind socket.io to express
var socket = io.listen(server);
socket.sockets.on('connection', function (socket) {
	console.log("received connection");
	//socket.emit('message', { hello: 'world' });
	/*socket.on('message', function (data) {
		console.log(data);
	});*/
});

app.configure(function(){
	app.use(express.static(publicdir));
});

/*
app.get('/', function(req, res){
	
	var body = 'Hello World';
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Length', body.length);
	res.end(body);
	res.send('Hello World');
});
*/

/// generator ////

var templates = {};

// parse out the file structure:
function walk(root, dir, done) {
	var realpath = root + "/" + dir;
	var results = {
		_srcdir: realpath,
	};
	fs.readdir(realpath, function(err, list) {
		if (err) return done(err);
		var pending = list.length;
    	if (!pending) return done(null, results);
		list.forEach(function(file) {
			// ignore the file if it is prefixed with ".":
			if (file[0] == ".") {
				if (!--pending) done(null, results);
			} else {
				var realfile = realpath + '/' + file;
				fs.stat(realfile, function(err, stat) {
					if (stat && stat.isDirectory()) {
						walk(root, dir + "/" + file, function(err, res) {
							results[file] = res;
							//results.push(res);
							if (!--pending) done(null, results);
						});
					} else {
						results[file] = realfile;
						//results.push(file);
						if (!--pending) done(null, results);
					}
				});
			}
		});
	});
}

// path is the containing relative path of the file
// name is the name of the file in this path
function visit(o, path, name, cb) {
	//console.log("visit", o, path, name);
	if (typeof o === "object") {
		for (var k in o) {
			if (k[0] != "_") {
				visit(o[k], path + name + "/", k, cb);
			}
		}
	} else {
		cb(name, path, o);
	}
}

function generate_md(name, path, srcfile) {
	//console.log("reading", srcfile);
	var data = fs.readFileSync(srcfile, "utf8") || "";
	//console.log("read", srcfile);
	
	// preprocess:
	var meta = props(data);
	
	// raw text is now at __content
	// all pragma properties are in pp
	var text = meta.__content || "";
	
	// parse the markdown:
	var tokens = marked.lexer(text, marked_options);
	//console.log(marked.lexer(text, marked_options));
	var html = marked.parser(tokens);
	
	var templatename = meta.template || "default";
	
	var template = templates[templatename];
	if (template) {
		
		// use meta for the template:
		meta.body = html;
	
		//console.log("filling template", templatename, meta.title, template);
		
		html = template(meta);
		//console.log(html);
	}
	
	var outname = publicdir + path + name + ".html";
	console.log("writing", outname);
	fs.writeFileSync(outname, html); 		
}

function generate_file(name, path, srcfile) {
	//console.log("-----", name, path, srcfile);
  			
  	// what kind of file is this?
	var dot = name.lastIndexOf('.');
	var pre = name.substr(0, dot) || name;
	var ext = name.substr(dot+1);
	
	// find the parser for this type:
	if (ext === "md") {
		// read & convert:
		generate_md(pre, path, srcfile);
	}
  			
  	//console.log("-----");
}

function generate() {
	// visit the templates:
	walk(srcdir, "templates", function(err, results) {
		if (err) throw err;
		
		visit(results, "", "", function(name, path, srcfile) {
		
			var data = fs.readFileSync(srcfile, "utf8");
			if (err) { return console.log(err); }
			
			// what kind of file is this?
			var dot = name.lastIndexOf('.');
			var pre = name.substr(0, dot) || name;
			var ext = name.substr(dot+1);
							
			// preprocess:
			var meta = props(data);
			
			// raw text is now at __content
			// all pragma properties are in pp
			var text = meta.__content || data;
			
			// compile for speed:
			var fn = mustache.compile(text);
			
			/*
			var jade_options = {
				// self: false, (use a self namespace to hold locals)
				// locals: ? (local variable object)
				filename: name,
				// debug: false,
				// compiler:  (replace Jade default)
				pretty: true, //add nicer indentation to result)
			};
			
			var fn = jade.compile(text, jade_options);
			*/
			
			//console.log(pre, fn);
			templates[pre] = fn;
		});
	});

	// visit the src folder:
	walk(srcdir, "pages", function(err, results) {
		if (err) throw err;
		
		// we now have a dictionary representing the file structure:
  		//console.log(results);
  		
  		visit(results, "", "", generate_file);
  		
  		console.log("site updated");	
	
		// broadcast message to all clients to refresh the page:
		//socket.broadcast.emit('reload');
		socket.sockets.emit('message', { cmd: "reload" });
	});
}

generate();

//// filewatching ////
var watchoptions = {
	ignoreDotFiles: true,
	// filter: function to return true/false,
};
watch.watchTree(srcdir, { persistent: true, interval: 100 }, function (f, curr, prev) {
	if (typeof f == "object" && prev === null && curr === null) {
		// Finished walking the tree
		//console.log("done");
	} else if (prev === null) {
		// f is a new file
		console.log("New file:", f);
		generate();
	} else if (curr.nlink === 0) {
		// f was removed
		console.log("Deleted file:", f);
		generate();
	} else {
		// f was changed
		console.log("Changed file:", f);
		generate();
	}
})

server.listen(3000);
console.log('Listening on port 3000');

