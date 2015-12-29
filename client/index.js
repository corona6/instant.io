var blobToBuffer = require('blob-to-buffer')
var debug = require('debug')('instant.io')
var dragDrop = require('drag-drop')
var listify = require('listify')
var parseTorrent = require('parse-torrent')
var path = require('path')
var Peer = require('simple-peer')
var prettyBytes = require('pretty-bytes')
var thunky = require('thunky')
var uploadElement = require('upload-element')
var WebTorrent = require('webtorrent')
var xhr = require('xhr')
var qrCode = require('qrcode-npm')

var util = require('./util')

global.WEBTORRENT_ANNOUNCE = [ 'wss://tracker.webtorrent.io' ]

var list=new Array;

if (!Peer.WEBRTC_SUPPORT) {
  util.error('This browser is unsupported. Please use a browser with WebRTC support.')
}

var getClient = thunky(function (cb) {
  xhr('/rtcConfig', function (err, res) {
    var rtcConfig
    if (err || res.statusCode !== 200) {
      util.error('Could not get WebRTC config from server. Using default (without TURN).')
    } else {
      try {
        rtcConfig = JSON.parse(res.body)
      } catch (err) {
        util.error('Got invalid WebRTC config from server: ' + res.body)
      }
      if (rtcConfig) debug('got rtc config: %o', rtcConfig)
    }
    var client = new WebTorrent({ rtcConfig: rtcConfig })
    client.on('warning', util.warning)
    client.on('error', util.error)
    cb(null, client)
  })
})

getClient(function (err, client) {
  if (err) return util.error(err)
  window.client = client
})

var upload = document.querySelector('input[name=upload]')
uploadElement(upload, function (err, files) {
  if (err) return util.error(err)
  files = files.map(function (file) { return file.file })
  onFiles(files)
})

dragDrop('body', onFiles)

document.querySelector('form').addEventListener('submit', function (e) {
  e.preventDefault()
  // downloadInfoHash(document.querySelector('form input[name=infoHash]').value)
  seed(list)
})

var hash = window.location.hash.replace('#', '')
if (/^[a-f0-9]+$/i.test(hash)) {
  downloadInfoHash(hash)
}

window.addEventListener('beforeunload', onBeforeUnload)

function onFiles (files) {
  debug('got files:')
  files.forEach(function (file) {
    list.push(file);
    debug(' - %s (%s bytes)', file.name, file.size)

    if (file.type.match('image.*')) {
      var reader = new FileReader();

      // Closure to capture the file information.
      reader.onload = (function(theFile) {
        return function(e) {
          // Render thumbnail.
          // var span = document.createElement('span');
          // span.innerHTML = ['<img class="thumb" src="', e.target.result,
          //                   '" title="', escape(theFile.name), '"/>'].join('');
          // document.getElementById('list').insertBefore(span, null);
          util.error('<img src="' + e.target.result + '">');
        };
      })(file);

      // Read in the image file as a data URL.
      reader.readAsDataURL(file);
    }

  })

  util.error(list.length + '個選択中');

  // Only process image files.

  // list.push(files);

  // // .torrent file = start downloading the torrent
  // files.filter(isTorrent).forEach(downloadTorrent)
  //
  // // everything else = seed these files
  // seed(files.filter(isNotTorrent))
}

function isTorrent (file) {
  var extname = path.extname(file.name).toLowerCase()
  return extname === '.torrent'
}

function isNotTorrent (file) {
  return !isTorrent(file)
}

function downloadInfoHash (infoHash) {
  util.log('Downloading torrent from <strong>infohash</strong> ' + infoHash)
  getClient(function (err, client) {
    if (err) return util.error(err)
    client.add(infoHash, onTorrent)
  })
}

function downloadTorrent (file) {
  debug('downloadTorrent %s', file.name || file)
  getClient(function (err, client) {
    if (err) return util.error(err)
    util.log('Downloading torrent from <strong>file</strong> ' + file.name)
    blobToBuffer(file, function (err, buf) {
      if (err) return util.error(err)
      var parsedTorrent = parseTorrent(buf)
      client.add(parsedTorrent, onTorrent)
    })
  })
}

function seed (files) {
  if (files.length === 0) return
  util.log('Seeding ' + files.length + ' files')

  // Seed from WebTorrent
  getClient(function (err, client) {
    if (err) return util.error(err)
    client.seed(files, onTorrent)
  })
}

function onTorrent (torrent) {
  upload.value = upload.defaultValue // reset upload element

  var torrentFileName = path.basename(torrent.name, path.extname(torrent.name)) + '.torrent'

  var qr = qrCode.qrcode(4, 'M')
  qr.addData('/#' + torrent.infoHash)
  qr.make()

  util.log(
    qr.createImgTag(4) +
    'Torrent info hash: ' + torrent.infoHash + ' ' +
    '<a href="/#' + torrent.infoHash + '" target="_blank">[Share link]</a> ' +
    '<a href="' + torrent.magnetURI + '" target="_blank">[Magnet URI]</a> ' +
    '<a href="' + torrent.torrentFileURL + '" target="_blank" download="' + torrentFileName + '">[Download .torrent]</a>'
  )

  function updateSpeed () {
    var progress = (100 * torrent.downloaded / torrent.parsedTorrent.length).toFixed(1)
    util.updateSpeed(
      '<b>Peers:</b> ' + torrent.swarm.wires.length + ' ' +
      '<b>Progress:</b> ' + progress + '% ' +
      '<b>Download speed:</b> ' + prettyBytes(window.client.downloadSpeed()) + '/s ' +
      '<b>Upload speed:</b> ' + prettyBytes(window.client.uploadSpeed()) + '/s'
    )
  }

  torrent.swarm.on('download', updateSpeed)
  torrent.swarm.on('upload', updateSpeed)
  setInterval(updateSpeed, 5000)
  updateSpeed()

  torrent.files.forEach(function (file) {
    // append file
    file.appendTo(util.logElem, function (err, elem) {
      if (err) return util.error(err)
    })

    // append download link
    file.getBlobURL(function (err, url) {
      if (err) return util.error(err)

      var a = document.createElement('a')
      a.target = '_blank'
      a.download = file.name
      a.href = url
      a.textContent = 'Download ' + file.name
      util.log(a)
    })
  })
}

function onBeforeUnload (e) {
  if (!e) e = window.event

  if (!window.client || window.client.torrents.length === 0) return

  var isLoneSeeder = window.client.torrents.some(function (torrent) {
    return torrent.swarm && torrent.swarm.numPeers === 0 && torrent.progress === 1
  })
  if (!isLoneSeeder) return

  var names = listify(window.client.torrents.map(function (torrent) {
    return '"' + (torrent.name || torrent.infoHash) + '"'
  }))

  var theseTorrents = window.client.torrents.length >= 2
    ? 'these torrents'
    : 'this torrent'
  var message = 'You are the only person sharing ' + names + '. ' +
    'Consider leaving this page open to continue sharing ' + theseTorrents + '.'

  if (e) e.returnValue = message // IE, Firefox
  return message // Safari, Chrome
}
