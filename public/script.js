const socket = io('/');
const videoGrid = document.getElementById('video-grid');

let myPeer;
let myVideoStream;
let myScreenStream;

let myScreenPeer; // Instance PeerJS dédiée à l'écran
let screenStream; // Le flux vidéo de l'écran
let currentScreenCall; // Pour stocker l'appel entrant du partage
let isScreenSharing = false;

/**flux vidéo */
const myVideo = document.createElement('video');
myVideo.muted = true;

const text = $("#chat_message");
const chatButton = document.querySelector('#chatButton');
/** share */
const copyLinkBtn = document.getElementById('copy-link-btn');
const copyCodeBtn = document.getElementById('copy-code-btn');
const emailShareBtn = document.getElementById('email-share-btn');
const nativeShareBtn = document.getElementById('native-share-btn');

const peers = {}; // Stocke les connexions Peer
const peersData = {}; // Stocke les info utilisateurs

// --- INITIALISATION ---
navigator.mediaDevices.getUserMedia({
  video: true,
  audio: true
}).then(stream => {
  myVideoStream = stream;
  addVideoStream(myVideo, stream, 'Moi');

  myPeer = new Peer(undefined, {
    path: '/peerjs',
    host: '/',
    port: '3030'
  });

  myPeer.on('open', id => {
    socket.emit('join-room', ROOM_ID, id)
  })

  myPeer.on('call', call => {
    call.answer(stream);
    const video = document.createElement('video');
    
    // Réception du flux distant
    call.on('stream', userVideoStream => {
      // On évite les doublons si le stream change (partage d'écran)
      if(!peers[call.peer]) { 
         addVideoStream(video, userVideoStream);
      }
    });
    // Important pour le partage d'écran: mettre à jour la src si le flux change
    call.on('stream', newStream => {
        video.srcObject = newStream;
    });
  });

  socket.on('user-connected', (userId, userName) => {
    console.log("User Connected: " + userName); 
    // Petit délai pour laisser le temps au PeerJS de l'autre de s'initialiser
    setTimeout(() => {
      connectToNewUser(userId, stream, userName);
    }, 1000);
    showNotification(`${userName} a rejoint la réunion`);
  });
  
  // --- CHAT ---
  /*$('#chat_message').keydown(function (e) {
    if (e.which == 13 && text.val().length !== 0) {
      socket.emit('message', text.val());
      text.val('');
    }
  });*/

  socket.on("createMessage", (message, userName) => {
    $(".messages").append(`<li class="message"><b>${userName}</b><br/>${message}</li>`);
    scrollToBottom();
  });

  // --- MAIN LEVÉE ---
  socket.on('hand-raised', (userId, userName) => {
    showNotification(`✋ ${userName} demande la parole !`, 'info');
  });

  socket.on('user-started-screen', (userId, username, screenPeerId) => {
    showNotification(`${username} partage son écran`);
    updatePresenterBadge(username);

    const call = myPeer.call(screenPeerId, new MediaStream()); // Stream vide factice ou null selon version PeerJS
    call.on('stream', (remoteScreenStream) => {
        // 2. Afficher dans la scène principale
        sharedScreenVideo.srcObject = remoteScreenStream;
        sharedScreenVideo.play();
        setFocusMode(true, sharedScreenVideo);
        currentScreenCall = call;
    });
  });

  socket.on('user-stopped-screen', () => {
    showNotification("Partage d'écran terminé");
    if (currentScreenCall) currentScreenCall.close();
    setFocusMode(false); // Retour grille
  });
  
  socket.on('user-disconnected', userId => {
    if (peers[userId]) peers[userId].close();
    
    // Supprimer l'élément HTML correspondant
    const videoWrapper = document.getElementById(`video-wrapper-${userId}`);
    if (videoWrapper) {
        videoWrapper.remove();
    }
  });

  // Réception de l'ordre d'ouvrir/fermer le tableau
  socket.on('whiteboard-toggled', (isOpen, username) => {
      if (isOpen) {
          updatePresenterBadge(username);
          setFocusMode(true, whiteboardWrapper);
          showNotification(`Tableau blanc activé par ${username}`);
      } else {
          hidePresenterBadge();
          setFocusMode(false);
      }
  });

  // Réception du dessin (socket)
  socket.on('draw-line', (data) => {
      // Conversion des coordonnées normalisées vers la taille réelle locale
      drawLine(
          data.x0 * canvas.width, 
          data.y0 * canvas.height, 
          data.x1 * canvas.width, 
          data.y1 * canvas.height, 
          data.color, 
          false
      );
  });

  socket.on('board-cleared', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

});

function connectToNewUser(userId, stream, username) {
  const call = myPeer.call(userId, stream);
  const video = document.createElement('video');
  call.on('stream', userVideoStream => {
    addVideoStream(video, userVideoStream, username);
  });
  call.on('close', () => {
    video.remove();
  });
  peers[userId] = call;
}

function addVideoStream(video, stream, labelName = '', uid = null) {
  video.srcObject = stream;
  video.addEventListener('loadedmetadata', () => {
    video.play();
  });
  
  const videoWrapper = document.createElement('div');
  videoWrapper.className = 'video-wrapper';
  
  // Si on a un ID utilisateur, on l'assigne au wrapper pour pouvoir le supprimer plus tard
  if (uid) {
      videoWrapper.id = `video-wrapper-${uid}`;
  }

  videoWrapper.append(video);

  if(labelName) {
      const label = document.createElement('div');
      label.className = 'video-label';
      label.innerText = labelName;
      videoWrapper.append(label);
  }
  videoGrid.append(videoWrapper);
}

// --- PARTAGE D'ÉCRAN ---
const shareScreen = async () => {
    if (isScreenSharing) {
        stopScreenShare();
        return;
    }

    try {
        // 1. Capturer l'écran
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always" },
            audio: false 
        });

        // 2. Créer un Peer temporaire juste pour l'écran
        myScreenPeer = new Peer(undefined, {
            path: '/peerjs',
            host: '/',
            port: '3030'
        });

        myScreenPeer.on('open', id => {
            // 3. Prévenir le serveur qu'on partage avec cet ID spécifique
            socket.emit('screen-share-start', id);
            isScreenSharing = true;
            
            // 4. Afficher mon propre écran localement dans la scène
            sharedScreenVideo.srcObject = screenStream;
            sharedScreenVideo.play();
            updatePresenterBadge('Moi');
            setFocusMode(true, sharedScreenVideo);
        });

        // Gestion fin du partage (Bouton navigateur "Arrêter le partage")
        screenStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };

    } catch (err) {
        console.error("Erreur partage:", err);
    }
};

const stopScreenShare = () => {
    if (!isScreenSharing) return;

    // 1. Couper le flux
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
    }
    
    // 2. Détruire le Peer temporaire
    if (myScreenPeer) {
        myScreenPeer.destroy();
    }

    isScreenSharing = false;
    hidePresenterBadge();
    setFocusMode(false); // Revenir en mode grille
    
    // 3. Prévenir les autres
    socket.emit('screen-share-stop');
};

// --- MAIN LEVÉE ---
const raiseHand = () => {
    socket.emit('raise-hand');
    showNotification("Vous avez levé la main");
}

// --- GESTION DU MODE FOCUS (Tableau / Partage) ---
const mainContentWrapper = document.querySelector('.main__content_wrapper');
const mainStage = document.getElementById('main-stage');
const whiteboardWrapper = document.getElementById('whiteboard-wrapper');

// Élément vidéo pour afficher le partage des autres
const sharedScreenVideo = document.createElement('video');
sharedScreenVideo.className = "w-100 h-100";
sharedScreenVideo.style.objectFit = "contain"; // Important pour voir tout l'écran
sharedScreenVideo.muted = true; // Toujours mute l'écran pour éviter l'écho

const presenterBadge = document.getElementById('presenter-badge');
const presenterNameText = document.getElementById('presenter-name-text');

// Canvas Logic
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');

const resizeCanvas = () => {
    // Le canvas prend la taille du conteneur parent (main-stage)
    if(canvas.parentNode) {
        canvas.width = canvas.parentNode.offsetWidth;
        canvas.height = canvas.parentNode.offsetHeight;
    }
};

// Gestionnaire du bouton "Tableau Blanc" (Modifié pour synchronisation)
const toggleWhiteboard = () => {
    const isHidden = whiteboardWrapper.classList.contains('d-none');
    // On inverse l'état actuel
    const newState = isHidden; 
    
    // 1. Mise à jour locale
    if (newState) {
        updatePresenterBadge('Moi');
        setFocusMode(true, whiteboardWrapper);
    } else {
        hidePresenterBadge();
        setFocusMode(false);
    }
    
    // 2. Prévenir les autres
    socket.emit('toggle-whiteboard', newState);
};

const closeFocusMode = () => {
    // Retire la classe CSS (retour grille)
    mainContentWrapper.classList.remove('focus-mode');
    // Cache la zone principale
    mainStage.classList.add('d-none');
    whiteboardWrapper.classList.add('d-none');
};

let drawing = false;
let current = { x: 0, y: 0 };

const getMousePos = (evt) => {
    const rect = canvas.getBoundingClientRect();
    return {
        // Calcul précis : position souris moins position canvas, mis à l'échelle
        x: (evt.clientX - rect.left) / (rect.right - rect.left) * canvas.width,
        y: (evt.clientY - rect.top) / (rect.bottom - rect.top) * canvas.height
    };
}

const drawLine = (x0, y0, x1, y1, color, emit) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.closePath();

    if (!emit) return;
    
    // On envoie des coordonnées normalisées (0 à 1)
    socket.emit('draw', {
        x0: x0 / canvas.width,
        y0: y0 / canvas.height,
        x1: x1 / canvas.width,
        y1: y1 / canvas.height,
        color: color
    });
};

// Events Souris corrigés
const onMouseDown = (e) => {
    drawing = true;
    const pos = getMousePos(e);
    current.x = pos.x;
    current.y = pos.y;
};

const onMouseMove = (e) => {
    if (!drawing) return;
    const pos = getMousePos(e);
    drawLine(current.x, current.y, pos.x, pos.y, document.getElementById('colorPicker').value, true);
    current.x = pos.x;
    current.y = pos.y;
};

const onMouseUp = (e) => {
    if (!drawing) return;
    drawing = false;
    const pos = getMousePos(e);
    drawLine(current.x, current.y, pos.x, pos.y, document.getElementById('colorPicker').value, true);
};

// Réattacher les listeners avec les nouvelles fonctions
canvas.removeEventListener('mousedown', onMouseDown); // Nettoyage au cas où
canvas.removeEventListener('mousemove', onMouseMove);
canvas.removeEventListener('mouseup', onMouseUp);

canvas.addEventListener('mousedown', onMouseDown, false);
canvas.addEventListener('mousemove', onMouseMove, false);
canvas.addEventListener('mouseup', onMouseUp, false);

const clearBoard = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    socket.emit('clear-board');
}

// --- UTILITAIRES ---
const setFocusMode = (active, contentElement = null) => {
    if (active) {
        // 1. Activer le CSS "Focus Mode" (Colonne à droite)
        mainContentWrapper.classList.add('focus-mode');
        mainStage.classList.remove('d-none');
        
        // 2. Vider la scène et ajouter le contenu demandé (Tableau ou Vidéo)
        mainStage.innerHTML = '';
        if (contentElement) {
            mainStage.appendChild(contentElement);
            contentElement.classList.remove('d-none');
            // Si c'est le tableau, on redimensionne le canvas immédiatement
            if(contentElement.id === 'whiteboard-wrapper') {
                setTimeout(resizeCanvas, 50);
            }
        }
    } else {
        // Désactiver le mode focus
        mainContentWrapper.classList.remove('focus-mode');
        mainStage.classList.add('d-none');
        whiteboardWrapper.classList.add('d-none'); // Cacher tableau
        mainStage.innerHTML = ''; // Nettoyer
    }
};

// Notifications
const showNotification = (msg, type='info') => {
    const notif = document.createElement('div');
    notif.className = `alert alert-${type}`;
    notif.style.marginBottom = '5px';
    notif.innerText = msg;
    document.getElementById('notification-area').appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
};

const scrollToBottom = () => {
  var d = $('.main__chat_window');
  d.scrollTop(d.prop("scrollHeight"));
}

const sendMessage = () => {
    let text = $("#chat_message");
    if (text.val().length !== 0) {
      socket.emit('message', text.val());
      text.val('');
    }
};

const muteUnmute = () => {
  const enabled = myVideoStream.getAudioTracks()[0].enabled;
  if (enabled) {
    myVideoStream.getAudioTracks()[0].enabled = false;
    setUnmuteButton();
  } else {
    setMuteButton();
    myVideoStream.getAudioTracks()[0].enabled = true;
  }
}

const playStop = () => {
  console.log('object')
  let enabled = myVideoStream.getVideoTracks()[0].enabled;
  if (enabled) {
    myVideoStream.getVideoTracks()[0].enabled = false;
    setPlayVideo()
  } else {
    setStopVideo()
    myVideoStream.getVideoTracks()[0].enabled = true;
  }
}

const setMuteButton = () => {
  const html = `
    <i class="fas fa-microphone"></i>
    <span>Mute</span>
  `
  document.querySelector('.main__mute_button').innerHTML = html;
}

const setUnmuteButton = () => {
  const html = `
    <i class="unmute fas fa-microphone-slash"></i>
    <span>Unmute</span>
  `
  document.querySelector('.main__mute_button').innerHTML = html;
}

const setStopVideo = () => {
  const html = `
    <i class="fas fa-video"></i>
    <span>Stop Video</span>
  `
  document.querySelector('.main__video_button').innerHTML = html;
}

const setPlayVideo = () => {
  const html = `
  <i class="stop fas fa-video-slash"></i>
    <span>Play Video</span>
  `
  document.querySelector('.main__video_button').innerHTML = html;
}

const toggleChat = () => {
  $('#chatModal').modal('toggle');
}

$('#chatModal').on('shown.bs.modal', function () {
  chatButton.style.color = '#ed4245'; // Rouge
  $('#chat_message').trigger('focus');
});

$('#chatModal').on('hidden.bs.modal', function () {
  chatButton.style.color = '#f2f3f5'; // Blanc cassé
});

$(function() {
  let chatIsDragging = false;
  let chatOffsetX, chatOffsetY;

  $('#chatModal .modal-header').on('mousedown', function(e) {
    chatIsDragging = true;
    const modal = $(this).closest('.modal-dialog');
    chatOffsetX = e.clientX - modal.offset().left;
    chatOffsetY = e.clientY - modal.offset().top;

    $(document).on('mousemove', function(e) {
      if (chatIsDragging) {
        const top = e.clientY - chatOffsetY;
        const left = e.clientX - chatOffsetX;
        modal.css({
          top: top + 'px',
          left: left + 'px',
          position: 'absolute'
        });
      }
    });
  });

  $(document).on('mouseup', function() {
    chatIsDragging = false;
    $(document).off('mousemove');
  });
});

const toggleInvite = () => {
  $('#inviteModal').modal('toggle');
}

// --- GESTION DU NOM PRÉSENTATEUR ---
const updatePresenterBadge = (name) => {
    presenterNameText.innerText = name;
    presenterBadge.classList.remove('d-none');
}

const hidePresenterBadge = () => {
    presenterBadge.classList.add('d-none');
    presenterNameText.innerText = '';
}

// Copier le lien d'invitation
copyLinkBtn.addEventListener('click', function () {
    const inviteLink = document.getElementById('invite-link').textContent;
    navigator.clipboard.writeText(inviteLink).then(function() {
        copyLinkBtn.textContent = 'Copié!';
        setTimeout(() => {
            copyLinkBtn.textContent = 'Copier';
        }, 2000);
        //afficherToast('Lien copié dans le presse-papier');
    });
});

// Copier le code de réunion
copyCodeBtn.addEventListener('click', function () {
    const meetingCode = document.getElementById('meeting-code').textContent;
    navigator.clipboard.writeText(meetingCode).then(function() {
        copyCodeBtn.textContent = 'Copié!';
        setTimeout(() => {
            copyCodeBtn.textContent = 'Copier';
        }, 2000);
        //afficherToast('Code copié dans le presse-papier');
    });
});

// Partager par email
emailShareBtn.addEventListener('click', function () {
    const subject = 'Invitation à rejoindre la réunion CIRAS MEET';
    const body = `Je vous invite à rejoindre ma réunion sur CIRAS MEET.\n\nRejoignez la réunion ici : https://localhost:3000/rejoindre/<%= idReunion %>\n\nCode de la réunion : <%= idReunion %>`;
    const mailtoLink = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailtoLink, '_blank');
});

// Partage natif
nativeShareBtn.addEventListener('click', function () {
    if (navigator.share) {
        navigator.share({
            title: 'Rejoindre ma réunion CIRAS MEET',
            text: 'Rejoignez ma réunion vidéo sur CIRAS MEET',
            url: `https://localhost:3000/rejoindre/<%= idReunion %>`
        }).catch(() => {
            // L'utilisateur a annulé le partage
        });
    } else {
        afficherToast('Le partage natif n\'est pas supporté sur ce navigateur', 'error');
    }
});
