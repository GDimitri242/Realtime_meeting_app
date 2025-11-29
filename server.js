/*server.js*/
const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const { v4: uuidV4 } = require('uuid');

const connectDB = require('./config/database');
const User = require('./models/User');
const { requireAuth } = require('./middleware/auth');

const dotenv = require("dotenv");
dotenv.config();

connectDB();

app.use(express.urlencoded({ extended: true }));

// Configuration de la session
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: true,
    saveUninitialized: true,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/videochat',
        ttl: 24 * 60 * 60 
    })
});

app.use(sessionMiddleware);

const options = {
  key: fs.readFileSync('certificats/localhost-key.pem'),
  cert: fs.readFileSync('certificats/localhost.pem')
}
const server = https.createServer(options, app);
const io = require('socket.io')(server);
const { ExpressPeerServer } = require('peer');
const peerServer = ExpressPeerServer(server, { debug: true });

// --- MIDDLEWARE SOCKET.IO POUR SESSION ---
// Permet d'accéder à req.session dans socket.io
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

app.use('/peerjs', peerServer);
app.set('view engine', 'ejs');
app.use(express.static('public'));

// --- ROUTES AUTHENTIFICATION ---
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
    try {
      const { username, password, confirmPassword } = req.body;
        if (password !== confirmPassword) {
            return res.render('register', { error: 'Les mots de passe ne correspondent pas' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username: username, password: hashedPassword });
        res.redirect('/login');
    } catch (e) { res.redirect('/register'); }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username: username });
  if (user && await bcrypt.compare(password, user.password)) {
      req.session.userId = user._id;
      req.session.username = user.username;
      req.session.save(); // Force la sauvegarde
      res.redirect('/home');
  } else {
      res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- ROUTES APP ---
app.get('/', (req, res) => res.render('index'));

app.get('/home', requireAuth, (req, res) => {
    res.render('dashboard', { userId: req.session.userId, username: req.session.username });
});

app.post('/create-room', requireAuth, (req, res) => {
    res.redirect(`/${uuidV4()}`);
});

app.get('/:room', requireAuth, (req, res) => {
    // On passe bien les variables à la vue
    res.render('room', { 
        dns: req.hostname, 
        roomId: req.params.room, 
        userId: req.session.userId, 
        username: req.session.username 
    });
});

// --- SOCKET IO ---
io.on('connection', socket => {
    // Récupération sécurisée du username depuis la session
    const session = socket.request.session;
    const sessionUsername = session && session.username ? session.username : 'Anonyme';

    socket.on('join-room', (roomId, userId) => {
        socket.join(roomId);
        
        // On utilise sessionUsername ici pour être sûr
        socket.to(roomId).emit('user-connected', userId, sessionUsername);

        socket.on('message', (message) => {
            io.to(roomId).emit('createMessage', message, sessionUsername);
        });

        socket.on('raise-hand', () => {
            socket.to(roomId).emit('hand-raised', userId, sessionUsername);
        });

        socket.on('screen-share-start', (screenPeerId) => {
            socket.to(roomId).emit('user-started-screen', userId, sessionUsername, screenPeerId);
        });

        socket.on('screen-share-stop', () => {
            socket.to(roomId).emit('user-stopped-screen');
        });

        socket.on('toggle-whiteboard', (isOpen) => {
            socket.to(roomId).emit('whiteboard-toggled', isOpen, sessionUsername);
        });

        socket.on('draw', (data) => {
            socket.to(roomId).emit('draw-line', data);
        });
        
        socket.on('clear-board', () => {
            io.to(roomId).emit('board-cleared');
        })

        socket.on('disconnect', () => {
            socket.to(roomId).emit('user-disconnected', userId);
        });
    });
});

const PORT = process.env.PORT || 3030;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur sécurisé démarré sur https://localhost:${PORT}`);
});
